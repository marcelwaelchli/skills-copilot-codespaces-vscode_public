// Checks the command line each tool operation assembles, without running the
// tool. Runs everywhere, whether or not the tools are installed.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { catalog } from '../src/catalog/index.js';

const windows = process.platform === 'win32';
const base = path.resolve('/projekt');
const at = (file) => path.resolve(base, file);

/** Runs an operation against a context that records what it would execute. */
async function commandOf(type, props) {
  const calls = [];
  const ctx = {
    baseDir: base,
    tmpDir: path.resolve('/tmp/lauf'),
    platform: process.platform,
    named: false,
    signal: new AbortController().signal,
    log() {},
    fail(message) {
      throw new Error(message);
    },
    path: at,
    vars: { get() {}, set() {}, all: () => ({}) },
    processOptions: (p) => ({ cwd: p.cwd, timeoutSec: p.timeout }),
    exec: async (cmd, args, options = {}) => {
      calls.push({ cmd, args, options });
      return { code: 1, stdout: '' };
    },
  };
  await catalog.get(type).run(ctx, props);
  return calls;
}

async function line(type, props) {
  const [call] = await commandOf(type, props);
  return [call.cmd, ...call.args];
}

test('npm, pnpm and yarn', async () => {
  assert.deepEqual(await line('build.npm', { manager: 'npm', command: 'run', script: 'build' }), ['npm', 'run', 'build']);
  assert.deepEqual(await line('build.npm', { manager: 'npm', command: 'ci' }), ['npm', 'ci']);
  assert.deepEqual(await line('build.npm', { manager: 'pnpm', command: 'ci' }), ['pnpm', 'install', '--frozen-lockfile']);
  assert.deepEqual(await line('build.npm', { manager: 'yarn', command: 'test', extraArgs: '--watch=false "a b"' }), ['yarn', 'test', '--watch=false', 'a b']);
});

test('working directory and time limit are passed on', async () => {
  const [call] = await commandOf('build.npm', { manager: 'npm', command: 'install', cwd: 'web', timeout: 90 });
  assert.deepEqual(call.options, { cwd: 'web', timeoutSec: 90 });
});

test('dotnet', async () => {
  assert.deepEqual(
    await line('build.dotnet', { command: 'publish', project: 'App.sln', configuration: 'Release', output: 'out', extraArgs: '--no-build' }),
    ['dotnet', 'publish', at('App.sln'), '-c', 'Release', '-o', at('out'), '--no-build'],
  );
  assert.deepEqual(await line('build.dotnet', { command: 'restore' }), ['dotnet', 'restore']);
});

test('MSBuild', async () => {
  const props = { project: 'App.sln', target: 'Rebuild', configuration: 'Release', platform: 'Any CPU', properties: 'Version=1.2.3\nDeterministic=true', tool: 'msbuild' };
  const expected = [at('App.sln'), '-nologo', '-t:Rebuild', '-p:Configuration=Release', '-p:Platform=Any CPU', '-p:Version=1.2.3', '-p:Deterministic=true'];
  assert.deepEqual(await line('build.msbuild', props), ['msbuild', ...expected]);
  assert.deepEqual(await line('build.msbuild', { ...props, tool: 'dotnet' }), ['dotnet', 'msbuild', ...expected]);
});

test('Maven and Gradle, with and without wrapper', async () => {
  assert.deepEqual(await line('build.maven', { goals: 'clean package', pom: 'server/pom.xml', skipTests: true }), ['mvn', '-B', 'clean', 'package', '-f', at('server/pom.xml'), '-DskipTests']);
  assert.deepEqual(await line('build.maven', { goals: 'verify', wrapper: true }), [windows ? '.\\mvnw.cmd' : './mvnw', '-B', 'verify']);
  assert.deepEqual(await line('build.gradle', { tasks: 'clean build', wrapper: true }), [windows ? '.\\gradlew.bat' : './gradlew', 'clean', 'build']);
  assert.deepEqual(await line('build.gradle', { tasks: 'test', wrapper: false, extraArgs: '--offline' }), ['gradle', 'test', '--offline']);
});

test('Make and CMake', async () => {
  assert.deepEqual(await line('build.make', { target: 'all', jobs: 4, makefile: 'build/Makefile' }), ['make', '-f', at('build/Makefile'), '-j4', 'all']);
  assert.deepEqual(await line('build.make', {}), ['make']);
  assert.deepEqual(
    await line('build.cmake', { mode: 'configure', source: '.', buildDir: 'build', config: 'Release', generator: 'Ninja' }),
    ['cmake', '-S', at('.'), '-B', at('build'), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'],
  );
  assert.deepEqual(await line('build.cmake', { mode: 'build', buildDir: 'build', config: 'Release', target: 'app' }), ['cmake', '--build', at('build'), '--config', 'Release', '--target', 'app']);
  assert.deepEqual(await line('build.cmake', { mode: 'install', buildDir: 'build', config: 'Release' }), ['cmake', '--install', at('build'), '--config', 'Release']);
});

test('Cargo, Go and Python', async () => {
  assert.deepEqual(await line('build.cargo', { command: 'build', release: true }), ['cargo', 'build', '--release']);
  assert.deepEqual(await line('build.go', { command: 'build', packages: './...', output: 'bin/app', extraArgs: '-v' }), ['go', 'build', '-o', at('bin/app'), '-v', './...']);
  assert.deepEqual(await line('build.go', { command: 'test', packages: './...' }), ['go', 'test', './...']);
  const python = windows ? 'python' : 'python3';
  assert.deepEqual(await line('build.python', { mode: 'script', target: 'tools/gen.py --all' }), [python, 'tools/gen.py', '--all']);
  assert.deepEqual(await line('build.python', { mode: 'module', target: 'pytest -q' }), [python, '-m', 'pytest', '-q']);
  assert.deepEqual(await line('build.python', { mode: 'pip', target: '-r requirements.txt', interpreter: 'py' }), ['py', '-m', 'pip', 'install', '-r', 'requirements.txt']);
});

test('Docker: options come before the image, the command after it', async () => {
  assert.deepEqual(
    await line('docker.build', { tag: 'app:1.0', context: '.', dockerfile: 'docker/Dockerfile', buildArgs: 'VERSION=1.0', platform: 'linux/amd64', noCache: true, extraArgs: '--pull' }),
    ['docker', 'build', '-t', 'app:1.0', '-f', at('docker/Dockerfile'), '--build-arg', 'VERSION=1.0', '--platform', 'linux/amd64', '--no-cache', '--pull', at('.')],
  );
  assert.deepEqual(
    await line('docker.run', { image: 'node:22', command: 'npm test', volumes: '/src:/work', envVars: 'CI=true', name: 'tests', rm: true, extraArgs: '-w /work' }),
    ['docker', 'run', '--rm', '--name', 'tests', '-v', '/src:/work', '-e', 'CI=true', '-w', '/work', 'node:22', 'npm', 'test'],
  );
  assert.deepEqual(await line('docker.push', { image: 'registry.example/app:1.0' }), ['docker', 'push', 'registry.example/app:1.0']);
  assert.deepEqual(
    await line('docker.compose', { command: 'up', file: 'compose.yaml', services: 'web db', detach: true, rebuild: true }),
    ['docker', 'compose', '-f', at('compose.yaml'), 'up', '-d', '--build', 'web', 'db'],
  );
  assert.deepEqual(await line('docker.compose', { command: 'down' }), ['docker', 'compose', 'down']);
});

test('Git commands', async () => {
  assert.deepEqual(
    await line('git.clone', { url: 'https://example.invalid/x.git', dest: 'x', branch: 'main', depth: 1 }),
    ['git', 'clone', '--branch', 'main', '--depth', '1', 'https://example.invalid/x.git', at('x')],
  );
  assert.deepEqual(await line('git.pull', { rebase: true }), ['git', 'pull', '--rebase']);
  assert.deepEqual(await line('git.checkout', { ref: 'release', create: true }), ['git', 'checkout', '-B', 'release']);
  assert.deepEqual(await line('git.tag', { name: 'v1.0', message: 'Erste Version', force: true }), ['git', 'tag', '--force', '-a', '-m', 'Erste Version', 'v1.0']);
  assert.deepEqual(await line('git.push', { remote: 'origin', ref: 'main', tags: true }), ['git', 'push', '--tags', 'origin', 'main']);
  assert.deepEqual(await line('git.push', { remote: 'origin', setUpstream: true }), ['git', 'push', '-u', 'origin', 'HEAD']);
});

test('Git commit stages first and commits only when something is staged', async () => {
  // The recording context answers every command with exit code 1, which for
  // `git diff --cached --quiet` means «there are staged changes».
  const calls = await commandOf('git.commit', { message: 'Version 1.0', paths: 'a.txt "b c.txt"', allowEmpty: true });
  assert.deepEqual(calls.map((call) => call.args), [['add', '--', 'a.txt', 'b c.txt'], ['diff', '--cached', '--quiet'], ['commit', '-m', 'Version 1.0']]);
  const all = await commandOf('git.commit', { message: 'Alles', allowEmpty: true });
  assert.deepEqual(all[0].args, ['add', '-A']);
});
