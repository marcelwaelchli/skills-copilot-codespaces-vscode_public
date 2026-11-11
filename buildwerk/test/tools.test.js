import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { catalog, SYSTEM_VARIABLES } from '../src/catalog/index.js';
import { formatCommand, splitArgs, stripAnsi } from '../src/process.js';
import { exportGithubActions, suggestWorkflowPath } from '../src/shared/export-gha.js';
import { cloneOp, createOp, summarize } from '../src/shared/model.js';
import { validateMacro } from '../src/shared/validate.js';
import { op, runMacro, tempDir } from './helpers.js';

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const systemNames = SYSTEM_VARIABLES.map((v) => v.name);
const macroOf = (operations, variables = []) => ({ format: 'buildwerk/1', name: 'Test', variables, operations });

test('splitArgs honours quotes; formatCommand quotes for display', () => {
  assert.deepEqual(splitArgs('a "b c" \'d e\' f=""  g'), ['a', 'b c', 'd e', 'f=', 'g']);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('""'), ['']);
  assert.equal(formatCommand('git', ['commit', '-m', 'zwei worte']), 'git commit -m "zwei worte"');
  assert.equal(stripAnsi('\x1b[32mgrün\x1b[0m'), 'grün');
});

test('every operation in the catalog is complete and consistent', () => {
  for (const def of catalog.values()) {
    assert.ok(def.label && def.description && def.icon && def.category, def.type);
    assert.ok(def.container || typeof def.run === 'function' || def.type === 'flow.runmacro', `${def.type} cannot run`);
    const keys = def.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, `${def.type} has duplicate field keys`);
    for (const field of def.fields) {
      if (field.showIf) assert.ok(keys.includes(field.showIf.key), `${def.type}.${field.key} depends on unknown field`);
      if (field.type === 'select') assert.ok(field.options.some((o) => o.value === field.default), `${def.type}.${field.key} default`);
    }
    // A freshly created operation must produce a summary without throwing.
    summarize(def, createOp(def));
  }
});

test('summaries describe an operation in one line', () => {
  const summary = (type, props) => summarize(catalog.get(type), { props });
  assert.equal(summary('flow.if', { left: '${OS}', operator: 'equals', right: 'windows' }), '${OS} = windows');
  assert.equal(summary('flow.if', { left: '${X}', operator: 'isEmpty', right: 'übrig' }), '${X} ist leer');
  assert.equal(summary('flow.foreach', { source: 'files', pattern: '*.txt', variable: 'F' }), 'F in *.txt');
  assert.equal(summary('flow.foreach', { source: 'range', from: '1', to: '9', variable: 'N' }), 'N von 1 bis 9');
  assert.equal(summary('build.npm', { manager: 'pnpm', command: 'run', script: 'build' }), 'pnpm run build');
  assert.equal(summary('build.npm', { manager: 'npm', command: 'ci', script: 'veraltet' }), 'npm ci');
  assert.equal(summary('run.shell', { script: '\necho eins\necho zwei' }), 'echo eins …');
});

test('validation finds structural problems, missing fields and unknown variables', () => {
  const problems = validateMacro(
    macroOf(
      [
        op('flow.else', {}, { id: 'orphan', children: [] }),
        op('flow.break', {}, { id: 'break' }),
        op('file.copy', { source: '', dest: '${ZIEL}/${TYPO}' }, { id: 'copy' }),
        op('run.shell', { script: 'echo ${HOME}' }, { id: 'shell' }),
        op('gibt.es.nicht', {}, { id: 'unknown' }),
        op('flow.fail', { message: '' }, { id: 'off', enabled: false }),
      ],
      [{ name: 'ZIEL', value: 'x' }, { name: 'ZIEL', value: 'y' }, { name: '1falsch', value: '' }, { name: 'OS', value: '' }],
    ),
    catalog,
    systemNames,
  );
  const about = (id, level) => problems.filter((p) => p.opId === id && p.level === level).map((p) => p.message);
  assert.equal(about('orphan', 'error').length, 1);
  assert.equal(about('break', 'error').length, 1);
  assert.match(about('copy', 'error')[0], /«Quelle» darf nicht leer sein/);
  assert.match(about('copy', 'warning')[0], /«TYPO»/);
  assert.equal(about('copy', 'warning').length, 1);
  assert.deepEqual(about('shell', 'warning'), []);
  assert.equal(about('unknown', 'error').length, 1);
  assert.deepEqual(problems.filter((p) => p.opId === 'off'), []);
  assert.equal(about(null, 'error').length, 3);
});

test('validation knows variables that operations create', () => {
  const problems = validateMacro(
    macroOf([
      op('git.info', { prefix: 'REPO_' }),
      op('flow.foreach', { source: 'list', items: 'a', variable: 'ITEM' }, { children: [op('var.log', { message: '${ITEM} ${REPO_COMMIT} ${LOOP_INDEX}' })] }),
    ]),
    catalog,
    systemNames,
  );
  assert.deepEqual(problems, []);
});

test('cloneOp gives every operation in the subtree a new id', () => {
  const original = op('flow.group', {}, { children: [op('var.log', { message: 'x' })] });
  const copy = cloneOp(original);
  assert.notEqual(copy.id, original.id);
  assert.notEqual(copy.children[0].id, original.children[0].id);
  assert.equal(copy.children[0].props.message, 'x');
});

test('GitHub Actions export passes variables through the environment', () => {
  const macro = macroOf([op('run.shell', { script: 'make', shell: 'auto' })], [
    { name: 'CONFIG', value: 'Release', description: "Art des Builds ('Debug' oder 'Release')" },
    { name: 'API_TOKEN', value: '', secret: true },
    { name: 'BUILD_NR', value: '1', persistent: true },
  ]);
  macro.name = 'Mein Build';
  const yaml = exportGithubActions(macro, { macroPath: 'build\\release.buildwerk.json', toolPath: 'buildwerk', branch: 'main' });
  assert.match(yaml, /^name: 'Mein Build'$/m);
  assert.match(yaml, /runs-on: ubuntu-latest/);
  assert.match(yaml, /run: node "buildwerk\/bin\/buildwerk.js" run "build\/release.buildwerk.json"/);
  assert.match(yaml, /BW_VAR_CONFIG: \$\{\{ inputs.CONFIG \}\}/);
  assert.match(yaml, /API_TOKEN: \$\{\{ secrets.API_TOKEN \}\}/);
  assert.match(yaml, /description: 'Art des Builds \(''Debug'' oder ''Release''\) \(Standard: Release\)'/);
  assert.ok(!yaml.includes('BW_VAR_API_TOKEN') && !yaml.includes('BW_VAR_BUILD_NR'));
  assert.ok(!/run:.*\$\{\{/.test(yaml), 'expressions must not be interpolated into the command line');
  assert.equal(suggestWorkflowPath(macro), '.github/workflows/mein-build.yml');
});

test('GitHub Actions export picks a Windows runner for Windows-only steps', () => {
  const yaml = exportGithubActions(macroOf([op('build.msbuild', { project: 'App.sln' })]), { macroPath: 'x.buildwerk.json' });
  assert.match(yaml, /runs-on: windows-latest/);
});

test('git operations work against a real repository', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
  } catch {
    return t.skip('git is not installed');
  }
  const dir = await tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'a.txt'), '1');
  const { result, vars, messages } = await runMacro(
    [
      op('git.commit', { message: 'erster commit', allowEmpty: true }),
      op('git.commit', { message: 'nichts neues', allowEmpty: true }),
      op('git.tag', { name: 'v1.0.0' }),
      op('git.info', { prefix: 'GIT_' }),
    ],
    { options: { macroFile: path.join(dir, 'x.buildwerk.json') } },
  );
  assert.equal(result.status, 'success', result.error);
  assert.equal(vars.GIT_BRANCH, 'main');
  assert.equal(vars.GIT_TAG, 'v1.0.0');
  assert.equal(vars.GIT_DIRTY, 'false');
  assert.match(vars.GIT_COMMIT, /^[0-9a-f]{40}$/);
  assert.ok(messages.includes('Keine Änderungen – Commit übersprungen.'));
  await fs.rm(dir, { recursive: true });
});

test('HTTP request, download and notification talk to a server', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url === '/fehler') res.writeHead(500).end('kaputt');
      else res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`antwort auf ${req.url}`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await tempDir();
  try {
    const { result, vars } = await runMacro(
      [
        op('net.http', { method: 'POST', url: `${base}/api`, headers: 'Authorization: Bearer ${TOKEN}', body: '{"v":1}', expect: '200-299', responseVar: 'ANTWORT' }),
        op('net.download', { url: `${base}/datei`, dest: path.join(dir, 'unter/datei.txt') }),
        op('net.notify', { service: 'slack', url: `${base}/hook`, message: 'Build fertig' }),
        op('net.http', { method: 'GET', url: `${base}/fehler`, expect: '200-299' }, { id: 'bad', onError: 'continue' }),
      ],
      { variables: [{ name: 'TOKEN', value: 'abc12345', secret: true }] },
    );
    assert.equal(result.status, 'success', result.error);
    assert.equal(vars.ANTWORT, 'antwort auf /api');
    assert.equal(await fs.readFile(path.join(dir, 'unter/datei.txt'), 'utf8'), 'antwort auf /datei');
    assert.deepEqual(received[0], { method: 'POST', url: '/api', auth: 'Bearer abc12345', body: '{"v":1}' });
    assert.deepEqual(JSON.parse(received[2].body), { text: 'Build fertig' });
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true });
  }
});

test('the example macros are valid and the tour runs through the CLI', async () => {
  const examples = path.join(toolDir, 'examples');
  for (const file of await fs.readdir(examples)) {
    const macro = JSON.parse(await fs.readFile(path.join(examples, file), 'utf8'));
    const problems = validateMacro(macro, catalog, systemNames);
    assert.deepEqual(problems, [], file);
  }
  const output = execFileSync(process.execPath, [path.join(toolDir, 'bin/buildwerk.js'), 'run', path.join(examples, 'rundgang.buildwerk.json'), '--var', 'PROJECT=cli-test'], {
    encoding: 'utf8',
  });
  assert.match(output, /Fertig: cli-test 1\.0\.1/);
  assert.match(output, /✔ Erfolgreich/);
});
