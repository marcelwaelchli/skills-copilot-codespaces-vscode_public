// Helpers for describing operation fields. The browser builds the property
// form from these descriptions, so adding an operation needs no UI work.

import { splitArgs } from '../process.js';

export const text = (key, label, extra = {}) => ({ key, label, type: 'text', ...extra });
export const filePath = (key, label, extra = {}) => ({ key, label, type: 'path', ...extra });
export const area = (key, label, extra = {}) => ({ key, label, type: 'textarea', ...extra });
export const code = (key, label, extra = {}) => ({ key, label, type: 'code', ...extra });
export const number = (key, label, extra = {}) => ({ key, label, type: 'number', ...extra });
export const check = (key, label, extra = {}) => ({ key, label, type: 'checkbox', default: false, ...extra });
export const variable = (key, label, extra = {}) => ({ key, label, type: 'variable', ...extra });

/** `options` may be plain strings or `{ value, label, short }`. */
export function select(key, label, options, extra = {}) {
  const normalized = options.map((option) => (typeof option === 'string' ? { value: option, label: option } : option));
  return { key, label, type: 'select', options: normalized, default: normalized[0].value, ...extra };
}

const advanced = { group: 'advanced' };

/** Fields every operation that starts a process offers. */
export const processFields = [
  filePath('cwd', 'Arbeitsverzeichnis', { ...advanced, placeholder: 'Basisverzeichnis des Makros' }),
  area('env', 'Umgebungsvariablen', { ...advanced, placeholder: 'NAME=Wert (eine pro Zeile)' }),
  number('timeout', 'Zeitlimit in Sekunden', { ...advanced, placeholder: 'kein Limit' }),
];

/**
 * An operation that wraps a command-line tool. `command(props, ctx)` returns
 * `{ cmd, args, tail }`; user-supplied extra arguments go between args and tail.
 */
export function toolOp({ command, fields, ...def }) {
  return {
    ...def,
    fields: [
      ...fields,
      text('extraArgs', 'Zusätzliche Argumente', { ...advanced, hint: 'Werden unverändert an den Befehl angehängt.' }),
      ...processFields,
    ],
    async run(ctx, p) {
      const { cmd, args, tail = [] } = command(p, ctx);
      await ctx.exec(cmd, [...args, ...splitArgs(p.extraArgs), ...tail], ctx.processOptions(p));
    },
  };
}

/** Adds `flag value` to an argument list when the value is set. */
export function opt(args, flag, value) {
  if (value !== undefined && value !== null && value !== '') args.push(flag, String(value));
  return args;
}
