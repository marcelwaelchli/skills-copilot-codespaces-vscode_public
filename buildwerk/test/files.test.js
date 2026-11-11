import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { glob, globAll } from '../src/glob.js';
import { createZip, extractZip } from '../src/zip.js';
import { op, runMacro, tempDir } from './helpers.js';

let dir;
const at = (...parts) => path.join(dir, ...parts);
const exists = (file) => fs.access(file).then(() => true, () => false);
const read = (file) => fs.readFile(file, 'utf8');

async function write(file, content = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** Runs file operations with `dir` as the macro's base directory. */
function run(operations, variables = []) {
  return runMacro(operations, { variables, options: { macroFile: at('test.buildwerk.json') } });
}

before(async () => {
  dir = await tempDir();
  await write(at('src/a.js'), 'a');
  await write(at('src/b.txt'), 'b');
  await write(at('src/sub/c.js'), 'c');
  await write(at('src/sub/deep/d.js'), 'd');
  await write(at('src/.hidden'), 'h');
});
after(() => fs.rm(dir, { recursive: true, force: true }));

const relative = (files) => files.map((file) => path.relative(dir, file).split(path.sep).join('/'));

test('glob: *, ** and ? patterns', async () => {
  assert.deepEqual(relative(await glob('src/*.js', dir)), ['src/a.js']);
  assert.deepEqual(relative(await glob('src/**/*.js', dir)), ['src/a.js', 'src/sub/c.js', 'src/sub/deep/d.js']);
  assert.deepEqual(relative(await glob('src/?.txt', dir)), ['src/b.txt']);
  assert.deepEqual(relative(await glob('src/*', dir)), ['src/.hidden', 'src/a.js', 'src/b.txt', 'src/sub']);
  assert.deepEqual(relative(await glob('src/a.js', dir)), ['src/a.js']);
  assert.deepEqual(await glob('src/nichts-*.js', dir), []);
  assert.deepEqual(await glob('fehlt/a.js', dir), []);
});

test('glob: several patterns with exclusions', async () => {
  assert.deepEqual(relative(await globAll('src/**/*.js\n!src/sub/deep/*', dir)), ['src/a.js', 'src/sub/c.js']);
});

test('copy: file to file, file into folder, folder, pattern', async () => {
  const { result } = await run([
    op('file.copy', { source: 'src/a.js', dest: 'out1/kopie.js', overwrite: true }),
    op('file.copy', { source: 'src/a.js', dest: 'out2/', overwrite: true }),
    op('file.copy', { source: 'src', dest: 'out3', overwrite: true }),
    op('file.copy', { source: 'src/**/*.js', dest: 'out4', overwrite: true }),
    op('file.copy', { source: 'src/**/*.js', dest: 'out5', overwrite: true, flatten: true }),
  ]);
  assert.equal(result.status, 'success', result.error);
  assert.equal(await read(at('out1/kopie.js')), 'a');
  assert.equal(await read(at('out2/a.js')), 'a');
  assert.equal(await read(at('out3/sub/deep/d.js')), 'd');
  assert.equal(await read(at('out4/sub/c.js')), 'c');
  assert.ok(!(await exists(at('out4/b.txt'))));
  assert.equal(await read(at('out5/d.js')), 'd');
});

test('copy: existing files are kept when overwrite is off', async () => {
  await write(at('keep/a.js'), 'alt');
  await run([op('file.copy', { source: 'src/a.js', dest: 'keep/a.js', overwrite: false })]);
  assert.equal(await read(at('keep/a.js')), 'alt');
});

test('copy: a missing source or an empty pattern is an error', async () => {
  const missing = await run([op('file.copy', { source: 'gibt-es-nicht', dest: 'x' })]);
  assert.match(missing.result.error, /existiert nicht/);
  const empty = await run([op('file.copy', { source: 'src/*.xyz', dest: 'x' })]);
  assert.match(empty.result.error, /Keine Dateien gefunden/);
});

test('move, mkdir with clean, delete', async () => {
  await write(at('work/alt.txt'), 'x');
  await write(at('work/tmp/1.tmp'), '');
  await write(at('work/tmp/2.tmp'), '');
  await write(at('work/tmp/bleibt.txt'), '');
  const { result } = await run([
    op('file.move', { source: 'work/alt.txt', dest: 'work/neu.txt', overwrite: true }),
    op('file.delete', { paths: 'work/tmp/*.tmp\nwork/fehlt' }),
    op('file.mkdir', { path: 'work/leer/tief' }),
    op('file.mkdir', { path: 'out1', clean: true }),
  ]);
  assert.equal(result.status, 'success', result.error);
  assert.ok(!(await exists(at('work/alt.txt'))));
  assert.equal(await read(at('work/neu.txt')), 'x');
  assert.deepEqual(await fs.readdir(at('work/tmp')), ['bleibt.txt']);
  assert.ok(await exists(at('work/leer/tief')));
  assert.deepEqual(await fs.readdir(at('out1')), []);
});

test('delete refuses to remove the file system root', async () => {
  const { result } = await run([op('file.delete', { paths: path.parse(dir).root })]);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Sicherheitsgründen/);
});

test('write, append, read and replace', async () => {
  const { result, vars } = await run(
    [
      op('file.write', { file: 'text/version.txt', content: 'version = ${V}\n', mode: 'overwrite' }),
      op('file.write', { file: 'text/version.txt', content: 'cost = $1 (a.b)\n', mode: 'append' }),
      op('file.replace', { files: 'text/*.txt', search: 'version = (\\d+)', replace: 'v$1', regex: true }),
      op('file.replace', { files: 'text/*.txt', search: '(a.b)', replace: '$& [x]' }),
      op('file.read', { file: 'text/version.txt', variable: 'INHALT', trim: true }),
    ],
    [{ name: 'V', value: '7' }],
  );
  assert.equal(result.status, 'success', result.error);
  assert.equal(vars.INHALT, 'v7\ncost = $1 $& [x]');
});

test('replace can require a match', async () => {
  const { result } = await run([op('file.replace', { files: 'src/a.js', search: 'kommt nicht vor', replace: '', mustMatch: true })]);
  assert.equal(result.status, 'failed');
});

test('zip and unzip round-trip, including empty folders and file modes', async () => {
  await fs.mkdir(at('src/leer'), { recursive: true });
  await write(at('src/run.sh'), '#!/bin/sh\n');
  await fs.chmod(at('src/run.sh'), 0o755);
  const { result } = await run([
    op('file.zip', { source: 'src', dest: 'pack/alles.zip', prefix: 'app' }),
    op('file.zip', { source: 'src/**/*.js', dest: 'pack/js.zip' }),
    op('file.unzip', { file: 'pack/alles.zip', dest: 'entpackt', clean: true }),
    op('file.unzip', { file: 'pack/js.zip', dest: 'entpackt-js' }),
  ]);
  assert.equal(result.status, 'success', result.error);
  assert.equal(await read(at('entpackt/app/sub/deep/d.js')), 'd');
  assert.equal(await read(at('entpackt/app/.hidden')), 'h');
  assert.ok(await exists(at('entpackt/app/leer')));
  assert.deepEqual((await fs.readdir(at('entpackt-js'))).sort(), ['a.js', 'sub']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(at('entpackt/app/run.sh'))).mode & 0o777, 0o755);
  }
  await fs.rm(at('src/leer'), { recursive: true });
  await fs.rm(at('src/run.sh'));
});

test('zip: archives are readable by the system unzip', async (t) => {
  await write(at('big/data.txt'), 'Buildwerk '.repeat(5000));
  await createZip(at('pack/big.zip'), [{ name: 'data.txt', file: at('big/data.txt') }]);
  try {
    execFileSync('unzip', ['-tq', at('pack/big.zip')], { stdio: 'pipe' });
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('unzip is not installed');
    throw error;
  }
  assert.ok((await fs.stat(at('pack/big.zip'))).size < 2000, 'content should be compressed');
});

test('unzip rejects entries that would escape the target folder', async () => {
  await write(at('evil-src.txt'), 'x');
  await createZip(at('pack/evil.zip'), [{ name: '../../ausbruch.txt', file: at('evil-src.txt') }]);
  await assert.rejects(extractZip(at('pack/evil.zip'), at('sicher/ziel')), /ausserhalb des Zielordners/);
  assert.ok(!(await exists(at('ausbruch.txt'))));
});
