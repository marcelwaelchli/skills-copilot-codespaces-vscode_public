// Renders the engine's event stream as an indented console log.

import { formatDuration } from './shared/model.js';

const CODES = { dim: 2, red: 31, green: 32, yellow: 33, cyan: 36, bold: 1 };

export function createConsoleReporter({ color = false, quiet = false, write = (line) => process.stdout.write(line + '\n') } = {}) {
  const paint = (style, text) => (color ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text);
  const execs = new Map();

  const indent = (depth) => '  '.repeat(depth);

  /** Prints the header of an operation (and of its ancestors) once it has something to show. */
  function open(exec) {
    if (!exec || exec.opened) return;
    open(exec.parent);
    exec.opened = true;
    write(`${indent(exec.depth)}${paint('cyan', '▸')} ${exec.label}`);
  }

  const STREAM_STYLE = { stderr: 'yellow', warn: 'yellow', error: 'red', command: 'cyan', info: 'dim' };
  const STATUS = {
    success: ['green', '✔'],
    failed: ['red', '✖'],
    warning: ['yellow', '!'],
    cancelled: ['yellow', '■'],
  };

  return function report(event) {
    switch (event.type) {
      case 'run-start':
        write(paint('bold', `Buildwerk · ${event.macro || 'Makro'}`));
        break;
      case 'op-start': {
        const parent = execs.get(event.parentExecId) || null;
        if (parent) parent.hasChildren = true;
        execs.set(event.execId, { label: event.label, parent, depth: parent ? parent.depth + 1 : 0, opened: false });
        break;
      }
      case 'output': {
        const exec = execs.get(event.execId);
        if (quiet && !['error', 'warn', 'stderr'].includes(event.stream)) break;
        open(exec);
        const style = STREAM_STYLE[event.stream];
        const prefix = `${indent(exec ? exec.depth + 1 : 0)}${paint('dim', '│')} `;
        for (const line of event.text.split('\n')) write(prefix + (style ? paint(style, line) : line));
        break;
      }
      case 'op-end': {
        const exec = execs.get(event.execId);
        if (!exec) break;
        execs.delete(event.execId);
        const [style, icon] = STATUS[event.status] || STATUS.success;
        if (event.status !== 'success' || !quiet) {
          open(exec.parent);
          // A leaf whose header is already on screen only needs its result, not its name again.
          const name = exec.opened && !exec.hasChildren ? '' : `${exec.label} `;
          write(`${indent(exec.depth)}${paint(style, icon)} ${name}${paint('dim', `(${formatDuration(event.durationMs)})`)}`);
        }
        if (event.error) for (const line of event.error.split('\n')) write(`${indent(exec.depth + 1)}${paint('red', line)}`);
        break;
      }
      case 'paused':
        write(paint('yellow', '⏸ Angehalten'));
        break;
      case 'run-end': {
        write('');
        const duration = formatDuration(event.durationMs);
        if (event.status === 'success') write(paint('green', `✔ Erfolgreich in ${duration}`));
        else if (event.status === 'cancelled') write(paint('yellow', `■ Abgebrochen nach ${duration}`));
        else write(paint('red', `✖ Fehlgeschlagen nach ${duration}`));
        break;
      }
      default:
        break;
    }
  };
}
