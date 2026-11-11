// Local web server behind the editor: serves the UI, stores macros in the
// workspace and runs them, streaming events to the browser.
//
// The server can execute arbitrary commands, so it is locked down: it binds to
// localhost, rejects unexpected Host headers (DNS rebinding) and requires a
// per-start token on every API call (cross-site requests).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeCatalog } from './catalog/index.js';
import { MacroRun } from './engine.js';
import { MACRO_EXTENSION } from './shared/model.js';
import { statOrNull } from './util.js';

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(toolDir, 'public');
const sharedDir = path.join(toolDir, 'src', 'shared');
const examplesDir = path.join(toolDir, 'examples');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 8 * 1024 * 1024;
const MAX_STORED_OUTPUT = 50_000;
const MAX_HISTORY = 50;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const posix = (file) => file.split(path.sep).join('/');

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Es wird application/json erwartet.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Die Anfrage ist zu gross.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Ungültiges JSON.');
  }
}

async function findRepoRoot(start) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (await statOrNull(path.join(dir, '.git'))) return dir;
    if (dir === path.dirname(dir)) return start;
  }
}

async function findMacros(root) {
  const found = [];
  async function scan(dir, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 6 && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) await scan(full, depth + 1);
      } else if (entry.name.endsWith(MACRO_EXTENSION)) {
        let name = entry.name.slice(0, -MACRO_EXTENSION.length);
        try {
          name = JSON.parse(await fs.readFile(full, 'utf8')).name || name;
        } catch {
          // listed anyway; opening it will show the error
        }
        found.push({ path: posix(path.relative(root, full)), name, modified: (await fs.stat(full)).mtimeMs });
      }
    }
  }
  await scan(root, 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function readFirstLine(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
    return buffer.toString('utf8', 0, bytesRead).split('\n')[0];
  } finally {
    await handle.close();
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.workspace] folder macros are stored in
 * @param {string[]} [options.allowHosts] extra Host header values to accept
 * @param {boolean} [options.allowAnyHost] disable the Host check
 */
export async function startServer({ port = 4800, host = '127.0.0.1', workspace = process.cwd(), allowHosts = [], allowAnyHost = false } = {}) {
  workspace = path.resolve(workspace);
  if (!(await statOrNull(workspace))?.isDirectory()) throw new Error(`Arbeitsbereich «${workspace}» ist kein Ordner.`);
  const token = randomBytes(24).toString('hex');
  const repoRoot = await findRepoRoot(workspace);
  const logsDir = path.join(workspace, '.buildwerk', 'logs');
  const pkg = JSON.parse(await fs.readFile(path.join(toolDir, 'package.json'), 'utf8'));

  /** @type {Map<string, {run: MacroRun, events: object[], subscribers: Set<http.ServerResponse>, done: boolean, stored: number}>} */
  const runs = new Map();
  let active = null;
  let allowedHosts = new Set();

  function inWorkspace(relative, extension) {
    if (typeof relative !== 'string' || !relative) throw new HttpError(400, 'Es fehlt ein Pfad.');
    const full = path.resolve(workspace, relative);
    if (!full.startsWith(workspace + path.sep)) throw new HttpError(400, 'Der Pfad liegt ausserhalb des Arbeitsbereichs.');
    if (extension && !full.endsWith(extension)) throw new HttpError(400, `Der Dateiname muss auf ${extension} enden.`);
    return full;
  }

  async function saveHistory(record, result) {
    const start = record.events[0];
    const stamp = new Date(start.t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const slug = (start.macro || 'makro').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'makro';
    const summary = { type: 'summary', macro: start.macro, file: record.path, startedAt: start.t, status: result.status, durationMs: result.durationMs };
    await fs.mkdir(logsDir, { recursive: true });
    const ignore = path.join(workspace, '.buildwerk', '.gitignore');
    if (!(await statOrNull(ignore))) await fs.writeFile(ignore, '*\n');
    const lines = [summary, ...record.events].map((event) => JSON.stringify(event));
    await fs.writeFile(path.join(logsDir, `${stamp}-${slug}.ndjson`), lines.join('\n') + '\n');
    const files = (await fs.readdir(logsDir)).filter((file) => file.endsWith('.ndjson')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - MAX_HISTORY))) await fs.rm(path.join(logsDir, old), { force: true });
  }

  const routes = {
    'GET /api/info': async () => ({
      version: pkg.version,
      workspace,
      platform: process.platform,
      activeRun: active && !active.done ? active.run.id : null,
      repo: {
        prefix: posix(path.relative(repoRoot, workspace)),
        toolPath: toolDir.startsWith(repoRoot + path.sep) ? posix(path.relative(repoRoot, toolDir)) : null,
      },
      ...describeCatalog(),
    }),

    'GET /api/macros': () => findMacros(workspace),

    'GET /api/macro': async ({ query }) => {
      const file = inWorkspace(query.get('path'), MACRO_EXTENSION);
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) {
        throw new HttpError(error.code === 'ENOENT' ? 404 : 422, `Makro konnte nicht geladen werden: ${error.message}`);
      }
    },

    'PUT /api/macro': async ({ query, body }) => {
      const file = inWorkspace(query.get('path'), MACRO_EXTENSION);
      if (!body || !Array.isArray(body.operations)) throw new HttpError(400, 'Das ist kein Makro.');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(body, null, 2) + '\n');
      return { path: posix(path.relative(workspace, file)) };
    },

    'GET /api/templates': async () => {
      const templates = [];
      for (const file of (await fs.readdir(examplesDir)).filter((name) => name.endsWith(MACRO_EXTENSION)).sort()) {
        const macro = JSON.parse(await fs.readFile(path.join(examplesDir, file), 'utf8'));
        templates.push({ file, name: macro.name, description: macro.description || '' });
      }
      return templates;
    },

    'GET /api/template': async ({ query }) => {
      const file = path.basename(query.get('file') || '');
      if (!file.endsWith(MACRO_EXTENSION)) throw new HttpError(400, 'Unbekannte Vorlage.');
      return JSON.parse(await fs.readFile(path.join(examplesDir, file), 'utf8'));
    },

    'POST /api/runs': async ({ body }) => {
      if (active && !active.done) throw new HttpError(409, 'Es läuft bereits ein Makro.');
      if (!body.macro || !Array.isArray(body.macro.operations)) throw new HttpError(400, 'Das ist kein Makro.');
      const run = new MacroRun(body.macro, {
        macroFile: body.path ? inWorkspace(body.path, MACRO_EXTENSION) : undefined,
        workspace,
        overrides: body.overrides || {},
        breakpoints: body.breakpoints || [],
        startAt: body.startAt || undefined,
        only: body.only || undefined,
        paused: Boolean(body.paused),
        // Questions go to the editor as `prompt` events and come back through the control endpoint.
        interactive: true,
      });
      const record = { run, path: body.path || null, events: [], subscribers: new Set(), done: false, stored: 0 };
      runs.set(run.id, record);
      for (const id of [...runs.keys()].slice(0, -10)) runs.delete(id);
      active = record;
      run.on('event', (event) => {
        // Very chatty builds are streamed in full but only stored up to a limit.
        if (event.type !== 'output' || record.stored++ < MAX_STORED_OUTPUT) record.events.push(event);
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        for (const res of record.subscribers) res.write(frame);
      });
      run.run().then(async (result) => {
        record.done = true;
        for (const res of record.subscribers) res.end();
        record.subscribers.clear();
        await saveHistory(record, result).catch((error) => console.error(`Protokoll konnte nicht gespeichert werden: ${error.message}`));
      });
      return { runId: run.id };
    },

    'GET /api/history': async () => {
      let files = [];
      try {
        files = (await fs.readdir(logsDir)).filter((file) => file.endsWith('.ndjson')).sort().reverse();
      } catch {
        return [];
      }
      const entries = [];
      for (const file of files) {
        try {
          entries.push({ id: file, ...JSON.parse(await readFirstLine(path.join(logsDir, file))) });
        } catch {
          // unreadable log: leave it out
        }
      }
      return entries;
    },

    'GET /api/history/log': async ({ query }) => {
      const file = path.basename(query.get('id') || '');
      if (!file.endsWith('.ndjson')) throw new HttpError(400, 'Unbekanntes Protokoll.');
      try {
        const content = await fs.readFile(path.join(logsDir, file), 'utf8');
        return content.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type !== 'summary');
      } catch {
        throw new HttpError(404, 'Das Protokoll existiert nicht mehr.');
      }
    },

    'POST /api/export/save': async ({ body }) => {
      if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(body.path || '')) {
        throw new HttpError(400, 'Workflows müssen unter .github/workflows/ liegen und auf .yml enden.');
      }
      const file = path.join(repoRoot, body.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(body.content ?? ''));
      return { file };
    },
  };

  function handleRunRoute(req, res, url) {
    const match = /^\/api\/runs\/([0-9a-f]+)\/(events|control)$/.exec(url.pathname);
    if (!match) return false;
    const record = runs.get(match[1]);
    if (!record) throw new HttpError(404, 'Dieser Lauf ist nicht mehr bekannt.');

    if (match[2] === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      for (const event of record.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (record.done) return res.end(), true;
      record.subscribers.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
      res.on('close', () => {
        clearInterval(heartbeat);
        record.subscribers.delete(res);
      });
      return true;
    }
    if (match[2] === 'control' && req.method === 'POST') {
      return readJson(req).then((body) => {
        const { run } = record;
        if (Array.isArray(body.breakpoints)) run.setBreakpoints(body.breakpoints);
        if (body.answer && !run.answer(body.answer.promptId, body.answer.value)) {
          throw new HttpError(409, 'Diese Frage wartet nicht mehr auf eine Antwort.');
        }
        if (body.action === 'stop') run.stop();
        else if (body.action === 'pause') run.pause();
        else if (body.action === 'resume') run.resume();
        else if (body.action === 'step') run.step();
        else if (body.action) throw new HttpError(400, 'Unbekannte Aktion.');
        sendJson(res, 200, { ok: true });
      });
    }
    return false;
  }

  async function serveStatic(res, url) {
    let relative = decodeURIComponent(url.pathname);
    let base = publicDir;
    if (relative.startsWith('/shared/')) {
      base = sharedDir;
      relative = relative.slice('/shared'.length);
    }
    if (relative === '/') relative = '/index.html';
    const file = path.join(base, relative);
    if (!file.startsWith(base + path.sep)) throw new HttpError(404, 'Nicht gefunden.');
    let content;
    try {
      content = await fs.readFile(file);
    } catch {
      throw new HttpError(404, 'Nicht gefunden.');
    }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (relative === '/index.html') {
      content = content.toString('utf8').replace('{{TOKEN}}', token);
      headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'";
      headers['X-Content-Type-Options'] = 'nosniff';
    }
    res.writeHead(200, headers);
    res.end(content);
  }

  function authorize(req, url) {
    if (!allowAnyHost && !allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
      throw new HttpError(403, `Host «${req.headers.host}» ist nicht erlaubt. Starte Buildwerk mit --allow-host ${req.headers.host}, wenn das beabsichtigt ist.`);
    }
    if (!url.pathname.startsWith('/api/')) return;
    const given = Buffer.from(String(req.headers['x-buildwerk-token'] || url.searchParams.get('token') || ''));
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, 'Sitzung abgelaufen – bitte die Seite neu laden.');
    }
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) {
      throw new HttpError(403, 'Anfragen von fremden Seiten sind nicht erlaubt.');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      authorize(req, url);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') throw new HttpError(405, 'Methode nicht erlaubt.');
        return await serveStatic(res, url);
      }
      const handled = handleRunRoute(req, res, url);
      if (handled) return void (await handled);
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, 'Unbekannte Schnittstelle.');
      const body = req.method === 'GET' ? null : await readJson(req);
      sendJson(res, 200, await route({ query: url.searchParams, body }));
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (!(error instanceof HttpError)) console.error(error);
      sendJson(res, error.status || 500, { error: error.status ? error.message : `Interner Fehler: ${error.message}` });
    }
  });

  // Take the next free port when the preferred one is busy.
  const boundPort = await new Promise((resolve, reject) => {
    let candidate = port;
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE' && candidate < port + 20) server.listen(++candidate, host);
      else reject(error);
    });
    server.on('listening', () => resolve(server.address().port));
    server.listen(candidate, host);
  });

  allowedHosts = new Set([`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`, ...(allowHosts || []).map((name) => name.toLowerCase())]);
  // GitHub Codespaces forwards ports under a predictable, authenticated hostname.
  const { CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN } = process.env;
  if (CODESPACE_NAME && GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    allowedHosts.add(`${CODESPACE_NAME}-${boundPort}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`.toLowerCase());
  }

  return {
    url: `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${boundPort}`,
    port: boundPort,
    workspace,
    token,
    close: () =>
      new Promise((resolve) => {
        if (active && !active.done) active.run.stop();
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
