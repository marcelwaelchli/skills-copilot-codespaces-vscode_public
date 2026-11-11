import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { group, log, op, runMacro, tempDir } from './helpers.js';

const posix = process.platform !== 'win32';
const cond = (left, operator, right) => ({ left, operator, right });

test('variables are substituted; $${} escapes; unset environment variables are empty', async () => {
  const { result, messages } = await runMacro(
    [op('var.set', { name: 'B', value: '${A}-2' }), log('${A} ${B} $${A} [${env:BW_TEST_ENV}]')],
    { variables: [{ name: 'A', value: 'eins' }] },
  );
  assert.equal(result.status, 'success');
  assert.deepEqual(messages, ['eins eins-2 ${A} []']);
});

test('a reference to an undefined variable fails instead of being used literally', async () => {
  const inField = await runMacro([log('hallo ${TYPO}', { id: 'a' }), log('nie')]);
  assert.equal(inField.result.status, 'failed');
  assert.match(inField.result.error, /Variable «TYPO» ist nicht definiert \(Feld «Meldung»\)/);
  assert.equal(inField.status.a, 'failed');

  const inDefault = await runMacro([log('nie')], { variables: [{ name: 'A', value: '${FEHLT}' }] });
  assert.equal(inDefault.result.status, 'failed');
  assert.match(inDefault.result.error, /«FEHLT».*Standardwert von «A»/);
});

test('shell scripts keep ${...} they do not know, so the shell can expand it', { skip: process.platform === 'win32' }, async () => {
  const { result, vars } = await runMacro([op('run.shell', { script: 'LOCAL=drin\necho "${LOCAL} ${A}"', shell: 'sh', outputVar: 'OUT' })], {
    variables: [{ name: 'A', value: 'makro' }],
  });
  assert.equal(result.status, 'success', result.error);
  assert.equal(vars.OUT, 'drin makro');
});

test('variable defaults may reference earlier variables and system variables', async () => {
  const { vars } = await runMacro([], {
    variables: [
      { name: 'NAME', value: 'app' },
      { name: 'FILE', value: '${NAME}-${OS}.zip' },
    ],
  });
  assert.match(vars.FILE, /^app-(linux|macos|windows)\.zip$/);
});

test('if / else-if / else runs exactly the first matching branch', async () => {
  const { status, messages } = await runMacro(
    [
      op('flow.if', cond('${X}', 'equals', '1'), { id: 'if', children: [log('eins', { id: 'a' })] }),
      op('flow.elseif', cond('${X}', 'gt', '1'), { id: 'elseif', children: [log('mehr', { id: 'b' })] }),
      op('flow.else', {}, { id: 'else', children: [log('sonst', { id: 'c' })] }),
    ],
    { variables: [{ name: 'X', value: '5' }] },
  );
  assert.ok(messages.includes('mehr'));
  assert.ok(!messages.includes('eins') && !messages.includes('sonst'));
  assert.equal(status.a, 'skipped');
  assert.equal(status.b, 'success');
  assert.equal(status.else, 'skipped');
  assert.equal(status.c, 'skipped');
});

test('condition operators', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'da.txt'), 'x');
  const cases = [
    [cond('Abc', 'equals', 'abc'), false],
    [{ ...cond('Abc', 'equals', 'abc'), ignoreCase: true }, true],
    [cond('release-1.2', 'matches', '^release-\\d+'), true],
    [cond('10', 'gt', '9'), true],
    [cond('${LEER}', 'isEmpty'), true],
    [cond('${LEER}', 'isNotEmpty'), false],
    [cond(path.join(dir, 'da.txt'), 'fileExists'), true],
    [cond(dir, 'dirExists'), true],
    [cond(path.join(dir, 'fehlt'), 'notExists'), true],
  ];
  for (const [props, expected] of cases) {
    const { messages } = await runMacro([op('flow.if', props, { children: [log('ja')] }), op('flow.else', {}, { children: [log('nein')] })], {
      variables: [{ name: 'LEER', value: '' }],
    });
    assert.equal(messages.includes('ja'), expected, JSON.stringify(props));
    assert.equal(messages.includes('nein'), !expected, JSON.stringify(props));
  }
  await fs.rm(dir, { recursive: true });
});

test('for-each over a list supports continue and break', async () => {
  const { messages, result } = await runMacro([
    op('flow.foreach', { source: 'list', items: 'a\nb\nc\nd', variable: 'ITEM' }, {
      children: [
        op('flow.if', cond('${ITEM}', 'equals', 'b'), { children: [op('flow.continue')] }),
        op('flow.if', cond('${ITEM}', 'equals', 'd'), { children: [op('flow.break')] }),
        log('wert ${ITEM} #${LOOP_INDEX}'),
      ],
    }),
  ]);
  assert.equal(result.status, 'success');
  assert.deepEqual(messages.filter((m) => m.startsWith('wert')), ['wert a #1', 'wert c #3']);
});

test('for-each over a number range and over files', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'a.txt'), '');
  await fs.writeFile(path.join(dir, 'b.md'), '');
  const { messages } = await runMacro([
    op('flow.foreach', { source: 'range', from: '2', to: '6', step: '2', variable: 'N' }, { children: [log('n${N}')] }),
    op('flow.foreach', { source: 'files', pattern: path.join(dir, '*.txt'), variable: 'F' }, { children: [log('f:${F}')] }),
  ]);
  assert.deepEqual(messages.filter((m) => /^n\d/.test(m)), ['n2', 'n4', 'n6']);
  assert.deepEqual(messages.filter((m) => m.startsWith('f:')), [`f:${path.join(dir, 'a.txt')}`]);
  await fs.rm(dir, { recursive: true });
});

test('while loops until the condition fails and enforces its limit', async () => {
  const counting = await runMacro(
    [op('flow.while', cond('${N}', 'lt', '3'), { children: [op('var.version', { name: 'N', part: 'last' })] })],
    { variables: [{ name: 'N', value: '0' }] },
  );
  assert.equal(counting.vars.N, '3');

  const endless = await runMacro([op('flow.while', { ...cond('1', 'equals', '1'), maxIterations: '5' }, { children: [log('x')] })]);
  assert.equal(endless.result.status, 'failed');
  assert.match(endless.result.error, /5 Durchläufen/);
});

test('try / catch / finally: the error is handled and finally always runs', async () => {
  const { result, messages, status } = await runMacro([
    op('flow.try', {}, { id: 'try', children: [op('flow.fail', { message: 'kaputt' }), log('nie')] }),
    op('flow.catch', {}, { children: [log('gefangen: ${ERROR_MESSAGE} / ${ERROR_OPERATION}')] }),
    op('flow.finally', {}, { children: [log('aufgeräumt')] }),
    log('weiter'),
  ]);
  assert.equal(result.status, 'success');
  assert.equal(status.try, 'failed');
  assert.deepEqual(messages, ['gefangen: kaputt / Fehler auslösen: kaputt', 'aufgeräumt', 'weiter']);
});

test('try without catch: finally runs, then the error propagates', async () => {
  const { result, messages } = await runMacro([
    op('flow.try', {}, { children: [op('flow.fail', { message: 'kaputt' })] }),
    op('flow.finally', {}, { children: [log('aufgeräumt')] }),
    log('nie'),
  ]);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'kaputt');
  assert.deepEqual(messages, ['aufgeräumt']);
});

test('catch is skipped when nothing fails', async () => {
  const { status } = await runMacro([
    op('flow.try', {}, { children: [log('ok')] }),
    op('flow.catch', {}, { id: 'catch', children: [log('nie', { id: 'inner' })] }),
  ]);
  assert.equal(status.catch, 'skipped');
  assert.equal(status.inner, 'skipped');
});

test('a failing operation stops the macro unless it is set to continue', async () => {
  const stopped = await runMacro([op('flow.fail', { message: 'aus' }, { id: 'f' }), log('nie', { id: 'after' })]);
  assert.equal(stopped.result.status, 'failed');
  assert.equal(stopped.status.f, 'failed');
  assert.equal(stopped.status.after, undefined);

  const tolerant = await runMacro([op('flow.fail', { message: 'egal' }, { id: 'f', onError: 'continue' }), log('doch', { id: 'after' })]);
  assert.equal(tolerant.result.status, 'success');
  assert.equal(tolerant.status.f, 'warning');
  assert.equal(tolerant.status.after, 'success');
});

test('the error message is reported once, on the operation that failed', async () => {
  const { events } = await runMacro([group([group([op('flow.fail', { message: 'tief' }, { id: 'f' })])])]);
  const withError = events.filter((e) => e.type === 'op-end' && e.error);
  assert.equal(withError.length, 1);
  assert.equal(withError[0].opId, 'f');
});

test('«Makro beenden» ends the run successfully', async () => {
  const { result, messages } = await runMacro([log('a'), group([op('flow.stop', { message: 'genug' })]), log('nie')]);
  assert.equal(result.status, 'success');
  assert.deepEqual(messages, ['a', 'genug']);
});

test('disabled operations and their children do not run', async () => {
  const { messages } = await runMacro([group([log('nie')], { enabled: false }), log('nie2', { enabled: false }), log('ja')]);
  assert.deepEqual(messages, ['ja']);
});

test('startAt skips everything before the start point, also inside blocks', async () => {
  const { messages, status } = await runMacro(
    [log('a', { id: 'a' }), group([log('b', { id: 'b' }), log('c', { id: 'c' }), log('d')], { id: 'g' }), log('e')],
    { options: { startAt: 'c' } },
  );
  assert.deepEqual(messages, ['c', 'd', 'e']);
  assert.equal(status.a, 'skipped');
  assert.equal(status.b, 'skipped');
  assert.equal(status.g, 'success');
});

test('startAt inside an if-branch enters that branch without evaluating the condition', async () => {
  const { messages } = await runMacro(
    [
      op('flow.if', cond('1', 'equals', '2'), { children: [log('im wenn', { id: 'target' })] }),
      op('flow.else', {}, { children: [log('im sonst')] }),
      log('danach'),
    ],
    { options: { startAt: 'target' } },
  );
  assert.deepEqual(messages, ['im wenn', 'danach']);
});

test('only runs a single operation with its children', async () => {
  const { messages } = await runMacro([log('a'), group([log('b'), log('c')], { id: 'g' }), log('d')], { options: { only: 'g' } });
  assert.deepEqual(messages, ['b', 'c']);
});

test('structural mistakes are reported before anything runs', async () => {
  const { result, messages } = await runMacro([log('nie'), op('flow.else', {}, { children: [] })]);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /«Sonst» muss direkt auf/);
  assert.deepEqual(messages, [result.error]);
});

test('parallel runs its children at the same time', async () => {
  const delay = () => op('flow.delay', { seconds: '0.3' });
  const { result } = await runMacro([op('flow.parallel', {}, { children: [delay(), delay(), delay()] })]);
  assert.equal(result.status, 'success');
  assert.ok(result.durationMs < 700, `took ${result.durationMs} ms`);
});

test('parallel reports a failure after all branches finished', async () => {
  const { result, messages } = await runMacro([
    op('flow.parallel', {}, { children: [op('flow.fail', { message: 'einer' }), group([op('flow.delay', { seconds: '0.1' }), log('anderer fertig')])] }),
  ]);
  assert.equal(result.status, 'failed');
  assert.ok(messages.includes('anderer fertig'));
});

test('stop() cancels a running macro', async () => {
  const { result, status } = await runMacro([op('flow.delay', { seconds: '30' }, { id: 'wait' }), log('nie')], {
    onRun: (run) => run.on('event', (event) => event.type === 'op-start' && setTimeout(() => run.stop(), 20)),
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(status.wait, 'cancelled');
  assert.ok(result.durationMs < 5000);
});

test('breakpoints pause the run; step and resume continue it', async () => {
  const pausedAt = [];
  const { result, messages } = await runMacro([log('a', { id: 'a' }), log('b', { id: 'b' }), log('c', { id: 'c' }), log('d', { id: 'd' })], {
    options: { breakpoints: ['b'] },
    onRun: (run) =>
      run.on('event', (event) => {
        if (event.type !== 'paused') return;
        pausedAt.push(event.opId);
        setImmediate(() => (pausedAt.length === 1 ? run.step() : run.resume()));
      }),
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(pausedAt, ['b', 'c']);
  assert.deepEqual(messages, ['a', 'b', 'c', 'd']);
});

test('secret values never appear in events', async () => {
  const { events } = await runMacro([log('token ist ${TOKEN}'), op('var.set', { name: 'COPY', value: 'x-${TOKEN}' })], {
    variables: [{ name: 'TOKEN', value: 'geheim-123', secret: true }],
  });
  assert.ok(!JSON.stringify(events).includes('geheim-123'));
  assert.ok(JSON.stringify(events).includes('token ist ***'));
});

test('secret variables without a default are read from the environment', async () => {
  process.env.BW_TEST_SECRET = 'aus-der-umgebung';
  const { vars, run } = await runMacro([], { variables: [{ name: 'BW_TEST_SECRET', value: '', secret: true }] });
  delete process.env.BW_TEST_SECRET;
  assert.equal(vars.BW_TEST_SECRET, '***');
  assert.equal(run.getVar('BW_TEST_SECRET'), 'aus-der-umgebung');
});

test('overrides win over defaults and may introduce new variables', async () => {
  const { messages } = await runMacro([log('${A} ${NEU}')], {
    variables: [{ name: 'A', value: 'standard' }],
    options: { overrides: { A: 'anders', NEU: 'dazu' } },
  });
  assert.deepEqual(messages, ['anders dazu']);
});

test('persistent variables keep their value between runs', async () => {
  const dir = await tempDir();
  const macroFile = path.join(dir, 'zaehler.buildwerk.json');
  const variables = [{ name: 'BUILD', value: '41', persistent: true }];
  const operations = [op('var.version', { name: 'BUILD', part: 'last' })];
  const first = await runMacro(operations, { variables, options: { macroFile } });
  const second = await runMacro(operations, { variables, options: { macroFile } });
  assert.equal(first.vars.BUILD, '42');
  assert.equal(second.vars.BUILD, '43');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'zaehler.buildwerk.state.json'), 'utf8')), { BUILD: '43' });
  await fs.rm(dir, { recursive: true });
});

test('a sub-macro runs with its own variables', async () => {
  const dir = await tempDir();
  const subFile = path.join(dir, 'unter.buildwerk.json');
  await fs.writeFile(
    subFile,
    JSON.stringify({
      format: 'buildwerk/1',
      name: 'Unter',
      variables: [{ name: 'WER', value: 'niemand' }],
      operations: [log('hallo ${WER}'), op('flow.stop', {}), log('nie')],
    }),
  );
  const { result, messages } = await runMacro([op('flow.runmacro', { file: subFile, variables: 'WER=${NAME}' }), log('zurück')], {
    variables: [{ name: 'NAME', value: 'welt' }],
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(messages, ['hallo welt', 'zurück']);
  await fs.rm(dir, { recursive: true });
});

test('inline JavaScript can read and write variables', async () => {
  const { vars, messages } = await runMacro(
    [op('var.script', { code: "const v = vars.get('V');\nvars.set('TAG', 'v' + v);\nlog('ok', 1 + 1);\nawait Promise.resolve();" })],
    { variables: [{ name: 'V', value: '2.0' }] },
  );
  assert.equal(vars.TAG, 'v2.0');
  assert.deepEqual(messages, ['ok 2']);
});

test('shell: variables arrive as environment, output is captured, variables come back', { skip: !posix }, async () => {
  const script = 'echo "hallo $NAME"\necho "ZURUECK=wert mit leerzeichen" >> "$BUILDWERK_VARS"';
  const { result, vars } = await runMacro([op('run.shell', { script, shell: 'sh', outputVar: 'OUT' })], {
    variables: [{ name: 'NAME', value: 'welt' }],
  });
  assert.equal(result.status, 'success');
  assert.equal(vars.OUT, 'hallo welt');
  assert.equal(vars.ZURUECK, 'wert mit leerzeichen');
});

test('shell: a non-zero exit code fails unless it is allowed', { skip: !posix }, async () => {
  const failing = await runMacro([op('run.shell', { script: 'echo vorher\nexit 3', shell: 'sh' })]);
  assert.equal(failing.result.status, 'failed');
  assert.match(failing.result.error, /Exit-Code 3/);
  assert.equal(failing.vars.LAST_EXIT_CODE, '3');

  const allowed = await runMacro([op('run.shell', { script: 'exit 3', shell: 'sh', okCodes: '0, 3' })]);
  assert.equal(allowed.result.status, 'success');
});

test('shell: stop() kills the running process tree', { skip: !posix }, async () => {
  const { result } = await runMacro([op('run.shell', { script: 'sleep 30 & wait', shell: 'sh' })], {
    onRun: (run) => run.on('event', (event) => event.type === 'op-start' && setTimeout(() => run.stop(), 100)),
  });
  assert.equal(result.status, 'cancelled');
  assert.ok(result.durationMs < 5000);
});

test('shell: the time limit ends a hanging process', { skip: !posix }, async () => {
  const { result } = await runMacro([op('run.shell', { script: 'sleep 30', shell: 'sh', timeout: '0.3' })]);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Zeitlimit/);
});

test('a missing program gives a helpful error', async () => {
  const { result } = await runMacro([op('run.program', { program: 'gibt-es-nicht-xyz', args: '--version' })]);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /nicht gefunden/);
});
