// Runs operations against the real tools. Each test is skipped when its tool
// is not installed, so the suite passes on a bare machine and checks as much
// as possible on a CI runner, including the Windows-specific paths.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { onPath, op, runMacro, tempDir } from './helpers.js';

const windows = process.platform === 'win32';
const exe = windows ? '.exe' : '';
const slow = { timeout: 240_000 };

let root;
before(async () => {
  root = await tempDir();
});
after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** Creates a project folder with the given files and returns a runner bound to it. */
async function project(name, files) {
  const dir = path.join(root, name);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
  await fs.mkdir(dir, { recursive: true });
  const run = (operations, variables = []) => runMacro(operations, { variables, options: { macroFile: path.join(dir, 'test.buildwerk.json') } });
  return { dir, run };
}

function expectSuccess({ result, messages }) {
  assert.equal(result.status, 'success', `${result.error}\n${messages.join('\n')}`);
}

// ------------------------------------------------------------- interpreters

test('shell: Node.js as interpreter', async () => {
  const { run } = await project('node-shell', {});
  const outcome = await run([op('run.shell', { script: "console.log('aus node: ' + process.env.NAME)", shell: 'node', outputVar: 'OUT' })], [{ name: 'NAME', value: 'welt' }]);
  expectSuccess(outcome);
  assert.equal(outcome.vars.OUT, 'aus node: welt');
});

test('shell: Python as interpreter', { skip: !onPath(windows ? 'python' : 'python3') }, async () => {
  const { run } = await project('python-shell', {});
  const outcome = await run([op('run.shell', { script: "import os\nprint('aus python: ' + os.environ['NAME'])", shell: 'python', outputVar: 'OUT' })], [{ name: 'NAME', value: 'welt' }]);
  expectSuccess(outcome);
  assert.equal(outcome.vars.OUT, 'aus python: welt');
});

// -------------------------------------------------------------- build tools

test('npm runs a package script', { skip: !onPath('npm'), ...slow }, async () => {
  const { run } = await project('npm', {
    'package.json': JSON.stringify({ name: 'hallo', version: '1.0.0', private: true, scripts: { gruss: 'node gruss.js' } }),
    'gruss.js': "console.log('hallo von npm');\n",
  });
  const outcome = await run([op('build.npm', { manager: 'npm', command: 'run', script: 'gruss' })]);
  expectSuccess(outcome);
  assert.ok(outcome.messages.includes('hallo von npm'), outcome.messages.join('\n'));
});

test('Python runs a script with arguments', { skip: !onPath(windows ? 'python' : 'python3') }, async () => {
  const { run } = await project('python', { 'gruss.py': "import sys\nprint('hallo von python', sys.argv[1])\n" });
  const outcome = await run([op('build.python', { mode: 'script', target: 'gruss.py "zwei worte"' })]);
  expectSuccess(outcome);
  assert.ok(outcome.messages.includes('hallo von python zwei worte'), outcome.messages.join('\n'));
});

test('Make builds a target', { skip: !onPath('make') }, async () => {
  const { run } = await project('make', { Makefile: 'gruss:\n\t@echo hallo von make\n' });
  const outcome = await run([op('build.make', { target: 'gruss' })]);
  expectSuccess(outcome);
  assert.ok(outcome.messages.includes('hallo von make'), outcome.messages.join('\n'));
});

test('CMake configures and builds', { skip: !onPath('cmake'), ...slow }, async () => {
  const { run } = await project('cmake', {
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\nproject(hallo NONE)\nadd_custom_target(gruss ALL COMMAND ${CMAKE_COMMAND} -E echo hallo-von-cmake)\n',
  });
  const outcome = await run([
    op('build.cmake', { mode: 'configure', source: '.', buildDir: 'build', config: 'Release' }),
    op('build.cmake', { mode: 'build', buildDir: 'build', config: 'Release' }),
  ]);
  expectSuccess(outcome);
  assert.ok(outcome.messages.some((line) => line.includes('hallo-von-cmake')), outcome.messages.join('\n'));
});

test('Go builds a program', { skip: !onPath('go'), ...slow }, async () => {
  const { dir, run } = await project('go', {
    'go.mod': 'module hallo\n\ngo 1.20\n',
    'main.go': 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hallo von go") }\n',
  });
  expectSuccess(await run([op('build.go', { command: 'build', packages: '.', output: `out/hallo${exe}` })]));
  assert.equal(execFileSync(path.join(dir, 'out', `hallo${exe}`), { encoding: 'utf8' }).trim(), 'hallo von go');
});

test('Cargo builds a program', { skip: !onPath('cargo'), ...slow }, async () => {
  const { dir, run } = await project('cargo', {
    'Cargo.toml': '[package]\nname = "hallo"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/main.rs': 'fn main() { println!("hallo von cargo"); }\n',
  });
  expectSuccess(await run([op('build.cargo', { command: 'build', extraArgs: '--offline' })]));
  assert.ok(existsSync(path.join(dir, 'target', 'debug', `hallo${exe}`)));
});

test('Maven runs a goal', { skip: !onPath('mvn'), ...slow }, async () => {
  const { run } = await project('maven', {
    'pom.xml':
      '<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>beispiel</groupId>\n  <artifactId>hallo</artifactId>\n  <version>1.0</version>\n  <packaging>pom</packaging>\n</project>\n',
  });
  // «validate» on a pom project needs no plugins, so it works offline on a fresh machine.
  expectSuccess(await run([op('build.maven', { goals: 'validate', extraArgs: '-o' })]));
});

test('Gradle runs a task', { skip: !onPath('gradle'), ...slow }, async () => {
  const { run } = await project('gradle', {
    'settings.gradle': "rootProject.name = 'hallo'\n",
    'build.gradle': "tasks.register('gruss') { doLast { println 'hallo von gradle' } }\n",
  });
  const outcome = await run([op('build.gradle', { tasks: 'gruss', wrapper: false, extraArgs: '--offline --no-daemon -q' })]);
  expectSuccess(outcome);
  assert.ok(outcome.messages.includes('hallo von gradle'), outcome.messages.join('\n'));
});

// ---------------------------------------------------------------------- git

test('Git: clone, commit, push, pull and checkout against a real remote', { skip: !onPath('git'), ...slow }, async () => {
  const { dir, run } = await project('git', {});
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  // Identity and settings come from the environment, so the test does not depend on the machine's git config.
  const saved = { ...process.env };
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    // No commit signing, and no line-ending conversion (Git for Windows turns LF into CRLF by default).
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_VALUE_1: 'false',
  });
  try {
    const remote = path.join(dir, 'remote.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    git(dir, 'clone', '-q', remote, 'seed');
    await fs.writeFile(path.join(dir, 'seed', 'a.txt'), 'eins\n');
    git(path.join(dir, 'seed'), 'add', '-A');
    git(path.join(dir, 'seed'), 'commit', '-q', '-m', 'start');
    git(path.join(dir, 'seed'), 'push', '-q', 'origin', 'HEAD:main');

    const outcome = await run([
      op('git.clone', { url: remote, dest: 'arbeit', branch: 'main' }),
      op('git.clone', { url: remote, dest: 'zweite', depth: 1, clean: true }),
      op('file.write', { file: 'arbeit/b.txt', content: 'zwei\n', mode: 'overwrite' }),
      op('git.commit', { repo: 'arbeit', message: 'b hinzugefügt', allowEmpty: false }),
      op('git.tag', { repo: 'arbeit', name: 'v1.0', message: 'Erste Version' }),
      op('git.push', { repo: 'arbeit', remote: 'origin', ref: 'main', tags: true }),
      op('git.pull', { repo: 'zweite' }),
      op('git.checkout', { repo: 'zweite', ref: 'neuer-zweig', create: true }),
      op('git.info', { repo: 'zweite', prefix: 'Z_' }),
    ]);
    expectSuccess(outcome);
    assert.equal(await fs.readFile(path.join(dir, 'zweite', 'b.txt'), 'utf8'), 'zwei\n');
    assert.equal(outcome.vars.Z_BRANCH, 'neuer-zweig');
    assert.equal(git(remote, 'tag', '--list'), 'v1.0');
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'main'), 'b hinzugefügt');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

// ------------------------------------------------------------- Windows only

test('windows: PowerShell is the default shell – output, umlauts and variables', { skip: !windows, ...slow }, async () => {
  const { run } = await project('ps', {});
  const outcome = await run(
    [
      op('run.shell', { script: 'Write-Output "Grüsse von $env:NAME"\nAdd-Content -Path $env:BUILDWERK_VARS -Value "ZURUECK=wert"', shell: 'auto', outputVar: 'OUT' }),
      // `>>` in Windows PowerShell writes UTF-16; Buildwerk has to read that as well.
      op('run.shell', { script: '"UMLAUT=später" >> $env:BUILDWERK_VARS', shell: 'powershell' }),
    ],
    [{ name: 'NAME', value: 'Zürich' }],
  );
  expectSuccess(outcome);
  assert.equal(outcome.vars.OUT, 'Grüsse von Zürich');
  assert.equal(outcome.vars.ZURUECK, 'wert');
  assert.equal(outcome.vars.UMLAUT, 'später');
});

test('windows: PowerShell failures fail the operation', { skip: !windows, ...slow }, async () => {
  const { run } = await project('ps-fail', {});
  const exitCode = await run([op('run.shell', { script: 'exit 3', shell: 'auto' })]);
  assert.equal(exitCode.result.status, 'failed');
  assert.match(exitCode.result.error, /Exit-Code 3/);
  const cmdlet = await run([op('run.shell', { script: 'Get-Item C:\\gibt-es-nicht-xyz\nWrite-Output "nie"', shell: 'auto' })]);
  assert.equal(cmdlet.result.status, 'failed');
  assert.ok(!cmdlet.messages.includes('nie'));
});

test('windows: cmd scripts – output, umlauts and variables', { skip: !windows, ...slow }, async () => {
  const { run } = await project('cmd', {});
  const outcome = await run(
    [op('run.shell', { script: 'echo Grüsse von %NAME%\necho ZURUECK=wert>>"%BUILDWERK_VARS%"', shell: 'cmd', outputVar: 'OUT' })],
    [{ name: 'NAME', value: 'welt' }],
  );
  expectSuccess(outcome);
  assert.equal(outcome.vars.OUT, 'Grüsse von welt');
  assert.equal(outcome.vars.ZURUECK, 'wert');
});

test('windows: arguments reach a .cmd wrapper intact', { skip: !windows, ...slow }, async () => {
  const { run } = await project('wrapper', {
    'zeige.cmd': '@echo off\r\nnode "%~dp0zeige.js" %*\r\n',
    'zeige.js': 'console.log(JSON.stringify(process.argv.slice(2)));\n',
  });
  const outcome = await run([op('run.program', { program: '.\\zeige.cmd', args: 'eins "zwei drei" a&b "x|y" (klammer) "sagt ""hallo"""', outputVar: 'OUT' })]);
  expectSuccess(outcome);
  assert.deepEqual(JSON.parse(outcome.vars.OUT), ['eins', 'zwei drei', 'a&b', 'x|y', '(klammer)', 'sagt hallo']);
});

test('windows: stop() ends a running process tree', { skip: !windows, ...slow }, async () => {
  const started = Date.now();
  const { result } = await runMacro([op('run.shell', { script: 'Start-Sleep -Seconds 60', shell: 'auto' })], {
    onRun: (run) => run.on('event', (event) => event.type === 'op-start' && setTimeout(() => run.stop(), 1500)),
  });
  assert.equal(result.status, 'cancelled');
  assert.ok(Date.now() - started < 30_000, 'the process should end long before its 60 seconds');
});
