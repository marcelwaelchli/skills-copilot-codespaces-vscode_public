#!/usr/bin/env node
// Buildwerk command line: run macros headless, start the editor, export workflows.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { catalog, CATEGORIES, SYSTEM_VARIABLES } from '../src/catalog/index.js';
import { MacroRun } from '../src/engine.js';
import { createConsoleReporter } from '../src/reporter.js';
import { exportGithubActions } from '../src/shared/export-gha.js';
import { opLabel, findOp } from '../src/shared/model.js';
import { askOnTerminal } from '../src/terminal.js';
import { validateMacro } from '../src/shared/validate.js';

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Buildwerk – visuelle Build- und Release-Automatisierung

Aufruf:
  buildwerk serve [Optionen]             Editor im Browser starten
  buildwerk run <makro> [Optionen]       Makro ohne Oberfläche ausführen
  buildwerk validate <makro>             Makro prüfen, ohne es auszuführen
  buildwerk export <makro> [Optionen]    GitHub-Actions-Workflow erzeugen
  buildwerk list                         Alle verfügbaren Operationen anzeigen

Optionen für serve:
  --port <n>            Port (Standard: 4800)
  --workspace <ordner>  Ordner mit den Makros (Standard: aktueller Ordner)
  --host <adresse>      Adresse, an die gebunden wird (Standard: 127.0.0.1)
  --allow-host <name>   Zusätzlich erlaubter Hostname, z. B. hinter einem Proxy (mehrfach möglich)
  --allow-any-host      Hostprüfung abschalten – nur in abgeschotteten Umgebungen verwenden
  --open                Browser automatisch öffnen

Optionen für run:
  --var NAME=Wert       Variable überschreiben (mehrfach möglich)
  --from <id>           Erst ab dieser Operation ausführen
  --only <id>           Nur diese Operation ausführen
  --quiet               Nur Fehler und Warnungen ausgeben
  --no-input            Keine Rückfragen stellen, sondern Vorgabewerte nehmen (wie in CI)
  --no-color            Keine Farben
  Variablen lassen sich auch über die Umgebung setzen: BW_VAR_NAME=Wert

Optionen für export:
  -o, --output <datei>  In Datei schreiben statt auf die Standardausgabe
  --branch <name>       Branch, dessen Pushes den Workflow auslösen (Standard: main)
`;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function loadMacro(file) {
  if (!file) fail('Es wurde keine Makrodatei angegeben.\n\n' + HELP);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    fail(`Makro «${file}» konnte nicht geladen werden: ${error.message}`);
  }
}

function printProblems(macro, problems) {
  for (const problem of problems) {
    const entry = problem.opId && findOp(macro, problem.opId);
    const where = entry ? `${opLabel(catalog.get(entry.op.type), entry.op)}: ` : '';
    process.stderr.write(`${problem.level === 'error' ? 'Fehler ' : 'Warnung'}  ${where}${problem.message}\n`);
  }
}

const systemNames = SYSTEM_VARIABLES.map((v) => v.name);

const commands = {
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        var: { type: 'string', multiple: true },
        from: { type: 'string' },
        only: { type: 'string' },
        quiet: { type: 'boolean' },
        'no-input': { type: 'boolean' },
        'no-color': { type: 'boolean' },
      },
    });
    const file = positionals[0];
    const macro = await loadMacro(file);

    const overrides = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith('BW_VAR_') && value !== '') overrides[name.slice(7)] = value;
    }
    for (const assignment of values.var || []) {
      const index = assignment.indexOf('=');
      if (index <= 0) fail(`Ungültige Angabe «--var ${assignment}». Erwartet: NAME=Wert`);
      overrides[assignment.slice(0, index)] = assignment.slice(index + 1);
    }

    // Questions are only asked when a person can answer: on a terminal, and not with --no-input.
    const interactive = Boolean(process.stdin.isTTY) && !values['no-input'];
    const run = new MacroRun(macro, {
      macroFile: path.resolve(file),
      workspace: process.cwd(),
      overrides,
      startAt: values.from,
      only: values.only,
      interactive,
    });
    if (interactive) {
      run.on('event', async (event) => {
        if (event.type !== 'prompt') return;
        const asking = new AbortController();
        const onInterrupt = () => {
          run.stop();
          asking.abort();
        };
        try {
          run.answer(event.promptId, await askOnTerminal(event, { signal: asking.signal, onInterrupt }));
        } catch {
          // interrupted while typing: the run is already stopping
        }
      });
    }
    const color = !values['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY;
    run.on('event', createConsoleReporter({ color, quiet: values.quiet }));
    process.once('SIGINT', () => run.stop());
    process.once('SIGTERM', () => run.stop());
    const result = await run.run();
    process.exitCode = { success: 0, cancelled: 130 }[result.status] ?? 1;
  },

  async validate(argv) {
    const file = argv[0];
    const macro = await loadMacro(file);
    const problems = validateMacro(macro, catalog, systemNames);
    printProblems(macro, problems);
    const errors = problems.filter((p) => p.level === 'error').length;
    process.stdout.write(errors ? `${errors} Fehler gefunden.\n` : 'Makro ist in Ordnung.\n');
    process.exitCode = errors ? 1 : 0;
  },

  async export(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { output: { type: 'string', short: 'o' }, branch: { type: 'string' } },
    });
    const file = positionals[0];
    const macro = await loadMacro(file);
    const yaml = exportGithubActions(macro, {
      macroPath: path.relative(process.cwd(), path.resolve(file)),
      toolPath: path.relative(process.cwd(), toolDir) || '.',
      branch: values.branch || 'main',
    });
    if (!values.output) return void process.stdout.write(yaml);
    const target = values.output;
    await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await fs.writeFile(target, yaml);
    process.stdout.write(`Workflow geschrieben: ${target}\n`);
  },

  async list() {
    for (const category of CATEGORIES) {
      process.stdout.write(`\n${category.label}\n`);
      for (const def of catalog.values()) {
        if (def.category === category.id) process.stdout.write(`  ${def.label.padEnd(28)} ${def.type}\n`);
      }
    }
  },

  async serve(argv) {
    const { values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        workspace: { type: 'string' },
        'allow-host': { type: 'string', multiple: true },
        'allow-any-host': { type: 'boolean' },
        open: { type: 'boolean' },
      },
    });
    const { startServer } = await import('../src/server.js');
    const server = await startServer({
      port: values.port ? Number(values.port) : undefined,
      host: values.host,
      workspace: values.workspace,
      allowHosts: values['allow-host'],
      allowAnyHost: values['allow-any-host'],
    });
    process.stdout.write(`Buildwerk läuft: ${server.url}\nArbeitsbereich:  ${server.workspace}\nBeenden mit Strg+C\n`);
    if (values['allow-any-host']) {
      process.stdout.write('\nAchtung: Die Hostprüfung ist abgeschaltet. Wer diesen Port erreicht, kann Befehle ausführen.\n');
    }
    if (values.open) {
      const { spawn } = await import('node:child_process');
      const opener = { win32: ['cmd', ['/c', 'start', '', server.url]], darwin: ['open', [server.url]] }[process.platform] || ['xdg-open', [server.url]];
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  },
};

// Piping into `head` and friends closes stdout early; that is not an error.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(HELP);
} else if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(await fs.readFile(path.join(toolDir, 'package.json'), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
} else if (commands[command]) {
  try {
    await commands[command](rest);
  } catch (error) {
    fail(error.code?.startsWith('ERR_PARSE_ARGS') ? `${error.message}\n\n${HELP}` : error.stack || error.message, 2);
  }
} else {
  fail(`Unbekannter Befehl «${command}».\n\n${HELP}`);
}
