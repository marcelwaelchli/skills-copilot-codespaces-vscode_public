import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startServer } from '../src/server.js';
import { log, op, tempDir } from './helpers.js';

let server;
let dir;

before(async () => {
  dir = await tempDir();
  server = await startServer({ port: 0, workspace: dir });
});
after(async () => {
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** Minimal HTTP client that allows forging the Host header, which fetch does not. */
function request(method, target, { body, headers = {}, token = server.token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path: target, method,
        headers: { ...(token ? { 'X-Buildwerk-Token': token } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, text, json, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const macro = (operations) => ({ format: 'buildwerk/1', name: 'Server Test', variables: [], operations });

async function collectEvents(runId) {
  const { text } = await request('GET', `/api/runs/${runId}/events?token=${server.token}`, { token: null });
  return text.split('\n\n').filter((frame) => frame.startsWith('data: ')).map((frame) => JSON.parse(frame.slice(6)));
}

test('serves the editor with the session token and a content security policy', async () => {
  const page = await request('GET', '/', { token: null });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(server.token));
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await request('GET', '/shared/model.js', { token: null })).status, 200);
  assert.equal((await request('GET', '/../package.json', { token: null })).status, 404);
  assert.equal((await request('GET', '/%2e%2e/package.json', { token: null })).status, 404);
});

test('rejects API calls without token, with a foreign Host or a foreign Origin', async () => {
  assert.equal((await request('GET', '/api/info', { token: null })).status, 401);
  assert.equal((await request('GET', '/api/info', { token: 'falsch' })).status, 401);
  assert.equal((await request('GET', '/api/info', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await request('GET', '/', { token: null, headers: { Host: 'evil.example' } })).status, 403);
  const crossSite = await request('POST', '/api/runs', { body: { macro: macro([]) }, headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  const notJson = await request('POST', '/api/runs', { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(notJson.status, 415);
});

test('info describes the catalog', async () => {
  const { json } = await request('GET', '/api/info');
  assert.equal(json.workspace, dir);
  assert.ok(json.operations.length > 50);
  assert.ok(json.operations.every((def) => typeof def.run === 'undefined'));
  assert.ok(json.categories.length && json.systemVariables.length);
});

test('macros are saved, listed and loaded – only inside the workspace', async () => {
  const saved = await request('PUT', '/api/macro?path=unter/eins.buildwerk.json', { body: macro([log('x')]) });
  assert.equal(saved.status, 200);
  const list = await request('GET', '/api/macros');
  assert.deepEqual(list.json.map((entry) => [entry.path, entry.name]), [['unter/eins.buildwerk.json', 'Server Test']]);
  const loaded = await request('GET', '/api/macro?path=unter/eins.buildwerk.json');
  assert.equal(loaded.json.operations[0].props.message, 'x');

  assert.equal((await request('PUT', '/api/macro?path=../raus.buildwerk.json', { body: macro([]) })).status, 400);
  assert.equal((await request('PUT', '/api/macro?path=falsch.json', { body: macro([]) })).status, 400);
  assert.equal((await request('PUT', '/api/macro?path=ok.buildwerk.json', { body: { kein: 'makro' } })).status, 400);
  assert.equal((await request('GET', '/api/macro?path=fehlt.buildwerk.json')).status, 404);
});

test('templates are offered from the examples folder', async () => {
  const { json } = await request('GET', '/api/templates');
  assert.ok(json.some((template) => template.file === 'rundgang.buildwerk.json'));
  const template = await request('GET', '/api/template?file=rundgang.buildwerk.json');
  assert.equal(template.json.name, 'Rundgang');
  assert.equal((await request('GET', '/api/template?file=../package.json')).status, 400);
});

test('a run streams its events and ends up in the history', async () => {
  const started = await request('POST', '/api/runs', { body: { macro: macro([log('hallo vom server', { id: 'a' })]) } });
  assert.equal(started.status, 200);
  const events = await collectEvents(started.json.runId);
  assert.equal(events[0].type, 'run-start');
  assert.ok(events.some((event) => event.type === 'output' && event.text === 'hallo vom server'));
  assert.deepEqual(events.at(-1).status, 'success');

  // The history file is written right after the stream closes.
  let history = [];
  for (let i = 0; i < 50 && history.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    history = (await request('GET', '/api/history')).json;
  }
  assert.equal(history[0].macro, 'Server Test');
  assert.equal(history[0].status, 'success');
  const replay = await request('GET', `/api/history/log?id=${history[0].id}`);
  assert.deepEqual(replay.json.map((event) => event.type), events.map((event) => event.type));
  assert.equal(await fs.readFile(path.join(dir, '.buildwerk', '.gitignore'), 'utf8'), '*\n');
});

test('a run can be paused at a breakpoint, stepped and stopped; only one run at a time', async () => {
  const operations = [log('a', { id: 'a' }), log('b', { id: 'b' }), op('flow.delay', { seconds: '30' }, { id: 'wait' })];
  const started = await request('POST', '/api/runs', { body: { macro: macro(operations), breakpoints: ['b'] } });
  const runId = started.json.runId;
  const control = (action) => request('POST', `/api/runs/${runId}/control`, { body: { action } });
  const eventTypes = async () => {
    const res = await fetch(`${server.url}/api/runs/${runId}/events?token=${server.token}`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(value);
  };
  const waitFor = async (needle) => {
    for (let i = 0; i < 100; i++) {
      if ((await eventTypes()).includes(needle)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`never saw ${needle}`);
  };

  await waitFor('"type":"paused","t"');
  assert.equal((await request('GET', '/api/info')).json.activeRun, runId);
  assert.equal((await request('POST', '/api/runs', { body: { macro: macro([]) } })).status, 409);
  await control('step');
  await waitFor('"opId":"wait"');
  await control('resume');
  await control('stop');
  const events = await collectEvents(runId);
  assert.equal(events.at(-1).status, 'cancelled');
  assert.equal((await control('unsinn')).status, 400);
  assert.equal((await request('GET', '/api/runs/abcdef/events')).status, 404);
});

test('a question from the macro reaches the client and is answered through the control endpoint', async () => {
  const operations = [op('var.prompt', { message: 'Welche Version?', variable: 'V', default: '1.0' }), log('v${V}')];
  const started = await request('POST', '/api/runs', { body: { macro: macro(operations) } });
  const runId = started.json.runId;

  // The run waits; the question is in the event stream for whoever connects.
  let prompt;
  for (let i = 0; i < 100 && !prompt; i++) {
    const res = await fetch(`${server.url}/api/runs/${runId}/events?token=${server.token}`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const frames = new TextDecoder().decode(value).split('\n\n').filter((frame) => frame.startsWith('data: '));
    prompt = frames.map((frame) => JSON.parse(frame.slice(6))).find((event) => event.type === 'prompt');
    if (!prompt) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(prompt.message, 'Welche Version?');
  assert.equal(prompt.fields[0].default, '1.0');

  const answer = (value) => request('POST', `/api/runs/${runId}/control`, { body: { answer: { promptId: prompt.promptId, value } } });
  assert.equal((await answer({ V: '3.1' })).status, 200);
  const events = await collectEvents(runId);
  assert.equal(events.at(-1).status, 'success');
  assert.ok(events.some((event) => event.type === 'output' && event.text === 'v3.1'));
  assert.equal((await answer({ V: 'zu spät' })).status, 409);
});

test('workflow export only writes below .github/workflows', async () => {
  const ok = await request('POST', '/api/export/save', { body: { path: '.github/workflows/build.yml', content: 'name: x\n' } });
  assert.equal(ok.status, 200);
  assert.equal(await fs.readFile(path.join(dir, '.github/workflows/build.yml'), 'utf8'), 'name: x\n');
  for (const bad of ['build.yml', '.github/workflows/../../x.yml', '.github/workflows/x.sh', '/etc/x.yml']) {
    assert.equal((await request('POST', '/api/export/save', { body: { path: bad, content: '' } })).status, 400, bad);
  }
});
