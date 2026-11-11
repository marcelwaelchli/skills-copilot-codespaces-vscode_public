// Variables, log output and inline scripting.

import { createRequire } from 'node:module';
import path from 'node:path';
import { area, code, select, text, variable } from './fields.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export default [
  {
    type: 'var.set',
    category: 'vars',
    label: 'Variable setzen',
    icon: 'variable',
    description: 'Weist einer Variablen einen Wert zu. Existiert sie noch nicht, wird sie angelegt.',
    fields: [variable('name', 'Variable', { required: true }), text('value', 'Wert')],
    summary: '{name} = {value}',
    run(ctx, p) {
      ctx.vars.set(p.name, p.value ?? '');
      if (ctx.named) ctx.log(`${p.name} = ${p.value ?? ''}`);
    },
  },
  {
    type: 'var.version',
    category: 'vars',
    label: 'Version erhöhen',
    icon: 'hash',
    description: 'Erhöht eine Versionsnummer wie 1.4.2 oder einen einfachen Zähler. Mit einer persistenten Variable entsteht so eine fortlaufende Build-Nummer.',
    fields: [
      variable('name', 'Variable', { required: true }),
      select('part', 'Stelle', [
        { value: 'last', label: 'Letzte Stelle', short: 'letzte Stelle' },
        { value: 'major', label: 'Hauptversion (1.x.x)', short: 'Hauptversion' },
        { value: 'minor', label: 'Nebenversion (x.1.x)', short: 'Nebenversion' },
        { value: 'patch', label: 'Patch (x.x.1)', short: 'Patch' },
      ]),
    ],
    summary: '{name} ({part})',
    run(ctx, p) {
      const current = (ctx.vars.get(p.name) || '').trim() || '0';
      const parts = current.split('.');
      const index = p.part === 'last' ? parts.length - 1 : { major: 0, minor: 1, patch: 2 }[p.part];
      while (parts.length <= index) parts.push('0');
      const number = Number(parts[index]);
      if (!Number.isInteger(number)) ctx.fail(`«${current}» ist keine Versionsnummer, die sich erhöhen lässt.`);
      parts[index] = String(number + 1);
      for (let i = index + 1; i < parts.length; i++) parts[i] = '0';
      ctx.vars.set(p.name, parts.join('.'));
      ctx.log(`${p.name}: ${current} → ${parts.join('.')}`);
    },
  },
  {
    type: 'var.log',
    category: 'vars',
    label: 'Meldung ausgeben',
    icon: 'message',
    description: 'Schreibt einen Text ins Protokoll.',
    fields: [
      area('message', 'Meldung', { required: true }),
      select('level', 'Art', [
        { value: 'info', label: 'Information' },
        { value: 'warn', label: 'Warnung' },
        { value: 'error', label: 'Fehler (nur Anzeige, bricht nicht ab)' },
      ]),
    ],
    summary: '{message}',
    plainLogLabel: true,
    run(ctx, p) {
      for (const line of String(p.message).split('\n')) ctx.log(line, p.level);
    },
  },
  {
    type: 'var.comment',
    category: 'vars',
    label: 'Notiz',
    icon: 'note',
    description: 'Ein Kommentar im Makro. Wird bei der Ausführung übersprungen.',
    fields: [area('text', 'Text', { raw: true })],
    summary: '{text}',
    run() {},
  },
  {
    type: 'var.script',
    category: 'vars',
    label: 'JavaScript',
    icon: 'code',
    description:
      'Führt JavaScript direkt in Buildwerk aus – für Berechnungen und Logik mit Variablen. Verfügbar sind vars.get(name), vars.set(name, wert), log(text), fail(text), require und fetch; await ist erlaubt.',
    fields: [code('code', 'Code', { required: true, raw: true, placeholder: "const v = vars.get('VERSION');\nvars.set('TAG', 'v' + v);" })],
    summary: '{code}',
    async run(ctx, p) {
      const fn = new AsyncFunction('vars', 'log', 'fail', 'require', p.code);
      const log = (...parts) => ctx.log(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
      await fn(ctx.vars, log, ctx.fail, createRequire(path.join(ctx.baseDir, 'buildwerk-script.js')));
    },
  },
];
