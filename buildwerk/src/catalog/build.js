// Wrappers around common build tools. Each one only assembles a command line.

import { splitArgs } from '../process.js';
import { parseKeyValues } from '../util.js';
import { area, check, filePath, number, opt, select, text, toolOp } from './fields.js';

const isWindows = process.platform === 'win32';
const build = (def) => toolOp({ category: 'build', icon: 'hammer', ...def });

export default [
  build({
    type: 'build.npm',
    label: 'npm / pnpm / yarn',
    icon: 'package',
    description: 'Installiert Abhängigkeiten oder führt ein Skript aus der package.json aus.',
    fields: [
      select('manager', 'Paketmanager', ['npm', 'pnpm', 'yarn', 'bun']),
      select('command', 'Aktion', [
        { value: 'install', label: 'Abhängigkeiten installieren (install)' },
        { value: 'ci', label: 'Saubere Installation nach Lockfile (ci)' },
        { value: 'run', label: 'Skript ausführen (run)' },
        { value: 'test', label: 'Tests ausführen (test)' },
        { value: 'publish', label: 'Paket veröffentlichen (publish)' },
      ]),
      text('script', 'Skriptname', { required: true, placeholder: 'build', showIf: { key: 'command', equals: 'run' } }),
    ],
    summary: '{manager} {command} {script}',
    command(p) {
      if (p.command === 'run') return { cmd: p.manager, args: ['run', p.script] };
      if (p.command === 'ci' && p.manager !== 'npm') return { cmd: p.manager, args: ['install', '--frozen-lockfile'] };
      return { cmd: p.manager, args: [p.command] };
    },
  }),
  build({
    type: 'build.dotnet',
    label: '.NET (dotnet)',
    description: 'Baut, testet oder veröffentlicht .NET-Projekte mit der dotnet-CLI.',
    fields: [
      select('command', 'Aktion', ['build', 'test', 'publish', 'pack', 'restore', 'clean', 'run']),
      filePath('project', 'Projekt oder Solution', { placeholder: 'im Arbeitsverzeichnis suchen' }),
      text('configuration', 'Konfiguration', { default: 'Release', showIf: { key: 'command', notIn: ['restore'] } }),
      filePath('output', 'Ausgabeordner', { showIf: { key: 'command', in: ['build', 'publish', 'pack'] } }),
    ],
    summary: '{command} {project} {configuration}',
    command(p, ctx) {
      const args = [p.command];
      if (p.project) args.push(ctx.path(p.project));
      opt(args, '-c', p.configuration);
      if (p.output) args.push('-o', ctx.path(p.output));
      return { cmd: 'dotnet', args };
    },
  }),
  build({
    type: 'build.msbuild',
    label: 'MSBuild',
    description: 'Baut Visual-Studio-Projekte und -Solutions mit MSBuild.',
    fields: [
      filePath('project', 'Projekt oder Solution', { required: true, placeholder: 'MeineApp.sln' }),
      text('target', 'Target', { default: 'Build' }),
      text('configuration', 'Konfiguration', { default: 'Release' }),
      text('platform', 'Plattform', { placeholder: 'Any CPU' }),
      area('properties', 'Eigenschaften', { placeholder: 'Name=Wert (eine pro Zeile)' }),
      select('tool', 'Aufruf über', [
        { value: 'msbuild', label: 'msbuild (Visual Studio Build Tools)', short: '' },
        { value: 'dotnet', label: 'dotnet msbuild', short: '(dotnet)' },
      ], { group: 'advanced' }),
    ],
    summary: '{project} {target} {configuration}',
    command(p, ctx) {
      const args = [ctx.path(p.project), '-nologo'];
      if (p.target) args.push(`-t:${p.target}`);
      if (p.configuration) args.push(`-p:Configuration=${p.configuration}`);
      if (p.platform) args.push(`-p:Platform=${p.platform}`);
      for (const [name, value] of Object.entries(parseKeyValues(p.properties))) args.push(`-p:${name}=${value}`);
      return p.tool === 'dotnet' ? { cmd: 'dotnet', args: ['msbuild', ...args] } : { cmd: 'msbuild', args };
    },
  }),
  build({
    type: 'build.maven',
    label: 'Maven',
    description: 'Führt Maven-Ziele aus.',
    fields: [
      text('goals', 'Ziele', { required: true, default: 'clean package' }),
      filePath('pom', 'POM-Datei', { placeholder: 'pom.xml im Arbeitsverzeichnis' }),
      check('skipTests', 'Tests überspringen'),
      check('wrapper', 'Maven Wrapper (mvnw) verwenden'),
    ],
    summary: '{goals}',
    command(p, ctx) {
      const args = ['-B', ...splitArgs(p.goals)];
      if (p.pom) args.push('-f', ctx.path(p.pom));
      if (p.skipTests) args.push('-DskipTests');
      return { cmd: p.wrapper ? (isWindows ? '.\\mvnw.cmd' : './mvnw') : 'mvn', args };
    },
  }),
  build({
    type: 'build.gradle',
    label: 'Gradle',
    description: 'Führt Gradle-Aufgaben aus.',
    fields: [
      text('tasks', 'Aufgaben', { required: true, default: 'build' }),
      check('wrapper', 'Gradle Wrapper (gradlew) verwenden', { default: true }),
    ],
    summary: '{tasks}',
    command: (p) => ({ cmd: p.wrapper ? (isWindows ? '.\\gradlew.bat' : './gradlew') : 'gradle', args: splitArgs(p.tasks) }),
  }),
  build({
    type: 'build.make',
    label: 'Make',
    description: 'Ruft make mit einem Ziel auf.',
    fields: [
      text('target', 'Ziel', { placeholder: 'Standardziel' }),
      number('jobs', 'Parallele Jobs'),
      filePath('makefile', 'Makefile', { group: 'advanced' }),
    ],
    summary: '{target}',
    command(p, ctx) {
      const args = [];
      if (p.makefile) args.push('-f', ctx.path(p.makefile));
      if (p.jobs) args.push(`-j${p.jobs}`);
      return { cmd: 'make', args: [...args, ...splitArgs(p.target)] };
    },
  }),
  build({
    type: 'build.cmake',
    label: 'CMake',
    description: 'Konfiguriert, baut oder installiert ein CMake-Projekt.',
    fields: [
      select('mode', 'Aktion', [
        { value: 'configure', label: 'Konfigurieren', short: 'konfigurieren' },
        { value: 'build', label: 'Bauen', short: 'bauen' },
        { value: 'install', label: 'Installieren', short: 'installieren' },
      ]),
      filePath('source', 'Quellordner', { default: '.', showIf: { key: 'mode', equals: 'configure' } }),
      filePath('buildDir', 'Build-Ordner', { required: true, default: 'build' }),
      text('config', 'Konfiguration', { default: 'Release' }),
      text('generator', 'Generator', { placeholder: 'Standard', showIf: { key: 'mode', equals: 'configure' } }),
      text('target', 'Target', { placeholder: 'alle', showIf: { key: 'mode', equals: 'build' } }),
    ],
    summary: '{mode} {buildDir} {config}',
    command(p, ctx) {
      const dir = ctx.path(p.buildDir);
      if (p.mode === 'configure') {
        const args = ['-S', ctx.path(p.source || '.'), '-B', dir];
        opt(args, '-G', p.generator);
        if (p.config) args.push(`-DCMAKE_BUILD_TYPE=${p.config}`);
        return { cmd: 'cmake', args };
      }
      const args = [p.mode === 'install' ? '--install' : '--build', dir];
      opt(args, '--config', p.config);
      if (p.mode === 'build') opt(args, '--target', p.target);
      return { cmd: 'cmake', args };
    },
  }),
  build({
    type: 'build.cargo',
    label: 'Cargo (Rust)',
    description: 'Baut oder testet ein Rust-Projekt.',
    fields: [select('command', 'Aktion', ['build', 'test', 'check', 'clippy', 'run', 'publish']), check('release', 'Release-Profil')],
    summary: '{command} {release}',
    command: (p) => ({ cmd: 'cargo', args: [p.command, ...(p.release ? ['--release'] : [])] }),
  }),
  build({
    type: 'build.go',
    label: 'Go',
    description: 'Baut oder testet Go-Pakete.',
    fields: [
      select('command', 'Aktion', ['build', 'test', 'vet', 'generate']),
      text('packages', 'Pakete', { default: './...' }),
      filePath('output', 'Ausgabedatei', { showIf: { key: 'command', equals: 'build' } }),
    ],
    summary: '{command} {packages}',
    command(p, ctx) {
      const args = [p.command];
      if (p.command === 'build' && p.output) args.push('-o', ctx.path(p.output));
      return { cmd: 'go', args, tail: splitArgs(p.packages) };
    },
  }),
  build({
    type: 'build.python',
    label: 'Python',
    icon: 'code',
    description: 'Führt ein Python-Skript oder -Modul aus oder installiert Pakete mit pip.',
    fields: [
      select('mode', 'Aktion', [
        { value: 'script', label: 'Skript ausführen', short: '' },
        { value: 'module', label: 'Modul ausführen (-m)', short: '-m' },
        { value: 'pip', label: 'Pakete installieren (pip install)', short: 'pip install' },
      ]),
      text('target', 'Skript, Modul oder Pakete', { required: true, placeholder: 'pytest -q  bzw.  -r requirements.txt' }),
      text('interpreter', 'Interpreter', { group: 'advanced', placeholder: isWindows ? 'python' : 'python3' }),
    ],
    summary: '{mode} {target}',
    command(p) {
      const cmd = p.interpreter || (isWindows ? 'python' : 'python3');
      const target = splitArgs(p.target);
      if (p.mode === 'module') return { cmd, args: ['-m', ...target] };
      if (p.mode === 'pip') return { cmd, args: ['-m', 'pip', 'install', ...target] };
      return { cmd, args: target };
    },
  }),
];
