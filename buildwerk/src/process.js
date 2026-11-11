// Child process handling: spawning without a shell, line-wise output,
// timeouts and killing the whole process tree on cancel.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CancelledError, OperationError } from './errors.js';

const isWindows = process.platform === 'win32';
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
  return text.replace(ANSI, '');
}

/** Splits a command-line fragment into arguments, honouring single and double quotes. */
export function splitArgs(text) {
  const args = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const char of String(text || '')) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
    }
  }
  if (started || current) args.push(current);
  return args;
}

/** Human-readable command line for the log (not used for execution). */
export function formatCommand(cmd, args) {
  return [cmd, ...args].map((arg) => (/[\s"'$&|<>;()]/.test(arg) || arg === '' ? JSON.stringify(arg) : arg)).join(' ');
}

/**
 * Finds the file behind a command, trying each PATHEXT extension, so that
 * `npm` finds `npm.cmd`. Bare names are looked up on PATH only – unlike
 * cmd.exe, never in the working directory, where a checked-out repository
 * could plant a look-alike. A path such as `.\gradlew.bat` is relative to it.
 */
function resolveWindowsCommand(cmd, env, cwd = process.cwd()) {
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir ? [cwd] : (env.Path || env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['', ...extensions]) {
      const candidate = path.resolve(dir, cmd + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep searching
      }
    }
  }
  return cmd;
}

// Quoting rules for cmd.exe, needed because .cmd/.bat files cannot be spawned directly.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function quoteForCmd(arg) {
  let quoted = String(arg)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, '^$1');
}

function spawnTarget(cmd, args, env, cwd) {
  if (!isWindows) return { file: cmd, args, options: {} };
  const resolved = resolveWindowsCommand(cmd, env, cwd);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved.replace(CMD_META, '^$1'), ...args.map(quoteForCmd)].join(' ');
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { file: resolved, args, options: {} };
}

function killTree(child) {
  if (!child.pid) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  const signal = (name) => {
    try {
      process.kill(-child.pid, name); // negative pid: the whole process group
    } catch {
      // already gone
    }
  };
  signal('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
  }, 2500).unref();
}

/**
 * Runs a program and resolves with its exit code once it has exited.
 * @param {object} options
 * @param {string} options.cmd
 * @param {string[]} [options.args]
 * @param {(line: string, stream: 'stdout'|'stderr') => void} [options.onLine]
 * @param {boolean} [options.verbatim] pass arguments to Windows untouched (caller did the quoting)
 */
export function runProcess({ cmd, args = [], cwd, env = process.env, signal, onLine, timeoutMs, verbatim }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());

    const target = verbatim
      ? { file: cmd, args, options: { windowsVerbatimArguments: true } }
      : spawnTarget(cmd, args, env, cwd);
    let child;
    try {
      child = spawn(target.file, target.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows, // own process group, so the whole tree can be signalled
        windowsHide: true,
        ...target.options,
      });
    } catch (error) {
      return reject(new OperationError(`«${cmd}» konnte nicht gestartet werden: ${error.message}`));
    }

    let timedOut = false;
    let cancelled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => ((timedOut = true), killTree(child)), timeoutMs) : null;
    const onAbort = () => ((cancelled = true), killTree(child));
    signal?.addEventListener('abort', onAbort, { once: true });

    const pipe = (stream, name) => {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const emit = (line) => onLine?.(stripAnsi(line), name);
      stream.on('data', (chunk) => {
        pending += decoder.write(chunk);
        const lines = pending.split(/\r\n|\n|\r/);
        pending = lines.pop();
        lines.forEach(emit);
      });
      stream.on('end', () => {
        pending += decoder.end();
        if (pending) emit(pending);
      });
    };
    pipe(child.stdout, 'stdout');
    pipe(child.stderr, 'stderr');

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      cleanup();
      if (error.code === 'ENOENT') {
        const missingDir = cwd && !fs.existsSync(cwd);
        reject(
          new OperationError(
            missingDir
              ? `Arbeitsverzeichnis «${cwd}» existiert nicht.`
              : `Programm «${cmd}» wurde nicht gefunden. Ist es installiert und im PATH?`,
          ),
        );
      } else {
        reject(new OperationError(`«${cmd}» konnte nicht gestartet werden: ${error.message}`));
      }
    });
    child.on('close', (code, killSignal) => {
      cleanup();
      if (cancelled) return reject(new CancelledError());
      if (timedOut) return reject(new OperationError(`Zeitlimit von ${Math.round(timeoutMs / 1000)} s überschritten – Prozess wurde beendet.`));
      resolve({ code: code ?? -1, signal: killSignal });
    });
  });
}
