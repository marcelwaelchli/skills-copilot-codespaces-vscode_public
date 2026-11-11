import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MacroRun } from '../src/engine.js';

let counter = 0;

/** Shorthand for building an operation in tests. */
export function op(type, props = {}, extra = {}) {
  const { children, ...rest } = extra;
  const result = { id: rest.id || `t${++counter}`, type, enabled: true, props, ...rest };
  if (children) result.children = children;
  return result;
}

export const log = (message, extra) => op('var.log', { message, level: 'info' }, extra);
export const group = (children, extra) => op('flow.group', {}, { children, ...extra });

export async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'buildwerk-test-'));
}

/** Runs a macro and collects what happened in a form that is easy to assert on. */
export async function runMacro(operations, { variables = [], options = {}, onRun } = {}) {
  const macro = { format: 'buildwerk/1', name: 'Test', variables, operations };
  const run = new MacroRun(macro, { workspace: os.tmpdir(), ...options });
  const events = [];
  run.on('event', (event) => events.push(event));
  onRun?.(run, events);
  const result = await run.run();
  const vars = {};
  const status = {};
  const messages = [];
  for (const event of events) {
    if (event.type === 'var') vars[event.name] = event.value;
    if (event.type === 'op-end') status[event.opId] = event.status;
    if (event.type === 'op-skip') status[event.opId] ??= 'skipped';
    if (event.type === 'output' && event.stream !== 'command') messages.push(event.text);
  }
  return { result, events, vars, status, messages, run };
}
