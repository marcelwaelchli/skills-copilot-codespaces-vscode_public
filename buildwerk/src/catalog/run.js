// Running shell scripts and programs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { OperationError } from '../errors.js';
import { splitArgs } from '../process.js';
import { area, code, processFields, select, text, variable } from './fields.js';

const isWindows = process.platform === 'win32';

/** How each interpreter is started for a script file. */
const SHELLS = {
  bash: { ext: '.sh', command: (file) => ['bash', ['--noprofile', '--norc', '-eo', 'pipefail', file]] },
  sh: { ext: '.sh', command: (file) => ['sh', ['-e', file]] },
  pwsh: { ext: '.ps1', command: (file) => ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file]], powershell: true },
  powershell: {
    ext: '.ps1',
    command: (file) => ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]],
    powershell: true,
  },
  cmd: { ext: '.cmd', command: (file) => [process.env.ComSpec || 'cmd.exe', ['/D', '/E:ON', '/V:OFF', '/S', '/C', `CALL "${file}"`]], verbatim: true },
  python: { ext: '.py', command: (file) => [isWindows ? 'python' : 'python3', [file]] },
  node: { ext: '.mjs', command: (file) => [process.execPath, [file]] },
};

function parseExitCodes(textValue) {
  const codes = String(textValue || '0').split(/[\s,;]+/).filter(Boolean).map(Number);
  if (codes.some((n) => !Number.isInteger(n))) throw new OperationError(`Ungültige Exit-Codes: «${textValue}».`);
  return codes;
}

const outputFields = [
  variable('outputVar', 'Ausgabe in Variable speichern', { group: 'advanced', hint: 'Die Standardausgabe des Prozesses, ohne Leerraum am Ende.' }),
  text('okCodes', 'Erlaubte Exit-Codes', { group: 'advanced', default: '0', hint: 'Mehrere Werte durch Komma trennen.' }),
];

async function runAndCapture(ctx, p, cmd, args, extra = {}) {
  const result = await ctx.exec(cmd, args, {
    ...ctx.processOptions(p),
    okCodes: parseExitCodes(p.okCodes),
    capture: Boolean(p.outputVar),
    ...extra,
  });
  if (p.outputVar) ctx.vars.set(p.outputVar, result.stdout.trimEnd());
}

export default [
  {
    type: 'run.shell',
    category: 'run',
    label: 'Shell-Befehl',
    icon: 'terminal',
    description:
      'Führt Befehle oder ein ganzes Skript aus. Makrovariablen stehen als ${NAME} und als Umgebungsvariablen bereit; mit echo "NAME=wert" >> "$BUILDWERK_VARS" gibt das Skript Variablen zurück.',
    fields: [
      code('script', 'Befehle', { required: true, passthrough: true, placeholder: 'npm run build' }),
      select('shell', 'Interpreter', [
        { value: 'auto', label: 'Automatisch (bash bzw. PowerShell)', short: '' },
        { value: 'bash', label: 'bash' },
        { value: 'sh', label: 'sh' },
        { value: 'pwsh', label: 'PowerShell 7 (pwsh)' },
        { value: 'powershell', label: 'Windows PowerShell' },
        { value: 'cmd', label: 'Eingabeaufforderung (cmd)' },
        { value: 'python', label: 'Python' },
        { value: 'node', label: 'Node.js' },
      ]),
      ...outputFields,
      ...processFields,
    ],
    summary: '{script}',
    async run(ctx, p) {
      const name = p.shell === 'auto' || !p.shell ? (isWindows ? 'powershell' : 'bash') : p.shell;
      const shell = SHELLS[name];
      if (!shell) throw new OperationError(`Unbekannter Interpreter «${name}».`);
      let script = p.script;
      if (shell.powershell) {
        // The BOM makes Windows PowerShell read the file as UTF-8; the encoding lines make it
        // write UTF-8 too. Without them, umlauts arrive garbled in both directions.
        const utf8 = '[System.Text.Encoding]::UTF8';
        const prelude = `$ErrorActionPreference = 'Stop'\ntry { [Console]::OutputEncoding = ${utf8} } catch {}\n$OutputEncoding = ${utf8}\n`;
        script = `﻿${prelude}${script}\nif (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }\n`;
      } else if (name === 'cmd') {
        // Code page 65001 = UTF-8, for the rest of the script file and for its output.
        script = `@echo off\r\nchcp 65001>nul\r\n${script.replace(/\r?\n/g, '\r\n')}\r\n`;
      }
      const file = path.join(ctx.tmpDir, `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${shell.ext}`);
      await fs.writeFile(file, script);
      const [cmd, args] = shell.command(file);
      // A one-line script is already visible in the operation's label.
      const lines = p.script.split('\n').filter((line) => line.trim());
      if (lines.length > 1 || ctx.named) for (const line of lines) ctx.log(line, 'command');
      await runAndCapture(ctx, p, cmd, args, { echo: false, verbatim: Boolean(shell.verbatim) });
    },
  },
  {
    type: 'run.program',
    category: 'run',
    label: 'Programm starten',
    icon: 'cog',
    description: 'Startet ein Programm direkt, ohne Shell dazwischen. Argumente werden so übergeben, wie sie hier stehen.',
    fields: [
      text('program', 'Programm', { required: true, placeholder: 'signtool' }),
      area('args', 'Argumente', { hint: 'Durch Leerzeichen oder Zeilenumbruch getrennt; Werte mit Leerzeichen in Anführungszeichen.' }),
      ...outputFields,
      ...processFields,
    ],
    summary: '{program} {args}',
    async run(ctx, p) {
      await runAndCapture(ctx, p, p.program, splitArgs(p.args));
    },
  },
];
