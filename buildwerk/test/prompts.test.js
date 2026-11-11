// Questions to the person running a macro: start values, input and confirmation.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { catalog, SYSTEM_VARIABLES } from '../src/catalog/index.js';
import { exportGithubActions } from '../src/shared/export-gha.js';
import { parseChoices } from '../src/shared/model.js';
import { validateMacro } from '../src/shared/validate.js';
import { askOnTerminal } from '../src/terminal.js';
import { log, op, runMacro } from './helpers.js';

/** Runs interactively and answers every question with `reply(event)`. */
function interactive(operations, reply, extra = {}) {
  const prompts = [];
  return runMacro(operations, {
    ...extra,
    options: { ...extra.options, interactive: true },
    onRun: (run) =>
      run.on('event', (event) => {
        if (event.type !== 'prompt') return;
        prompts.push(event);
        setImmediate(() => {
          const value = reply(event, run);
          if (value !== undefined) run.answer(event.promptId, value);
        });
      }),
  }).then((outcome) => ({ ...outcome, prompts }));
}

const config = { name: 'CONFIG', value: 'Release', description: 'Konfiguration', prompt: true, choices: 'Debug, Release' };

test('parseChoices splits on commas and line breaks', () => {
  assert.deepEqual(parseChoices(' Debug, Release\nTest ,, '), ['Debug', 'Release', 'Test']);
  assert.deepEqual(parseChoices(undefined), []);
});

test('variables marked for it are asked for in one form before the macro starts', async () => {
  const variables = [
    { name: 'BASIS', value: 'app' },
    config,
    { name: 'ZIEL', value: '${BASIS}-${CONFIG}', prompt: true },
    { name: 'DATEI', value: '${ZIEL}.zip' },
  ];
  const { result, messages, prompts } = await interactive([log('${CONFIG} ${ZIEL} ${DATEI}')], () => ({ CONFIG: 'Debug', ZIEL: 'eigenes-ziel' }), { variables });
  assert.equal(result.status, 'success', result.error);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].kind, 'form');
  assert.deepEqual(prompts[0].fields, [
    { name: 'CONFIG', label: 'Konfiguration', default: 'Release', choices: ['Debug', 'Release'], secret: false },
    { name: 'ZIEL', label: 'ZIEL', default: 'app-Release', choices: [], secret: false },
  ]);
  // Later defaults build on the answers, not on the values that were offered.
  assert.deepEqual(messages, ['Debug eigenes-ziel eigenes-ziel.zip']);
});

test('nobody to answer: start values fall back to the defaults', async () => {
  const { result, messages, events } = await runMacro([log('${CONFIG}')], { variables: [config] });
  assert.equal(result.status, 'success');
  assert.deepEqual(messages, ['Release']);
  assert.ok(!events.some((event) => event.type === 'prompt'));
});

test('a value that was passed in is not asked for again', async () => {
  const { messages, prompts } = await interactive([log('${CONFIG}')], () => assert.fail('should not ask'), { variables: [config], options: { overrides: { CONFIG: 'Debug' } } });
  assert.deepEqual(messages, ['Debug']);
  assert.equal(prompts.length, 0);
});

test('values outside the allowed choices are rejected, wherever they come from', async () => {
  const answered = await interactive([log('nie')], () => ({ CONFIG: 'Unsinn' }), { variables: [config] });
  assert.equal(answered.result.status, 'failed');
  assert.match(answered.result.error, /«Unsinn» ist kein erlaubter Wert für «CONFIG» \(erlaubt: Debug, Release\)/);
  const passedIn = await runMacro([log('nie')], { variables: [config], options: { overrides: { CONFIG: 'Unsinn' } } });
  assert.equal(passedIn.result.status, 'failed');
});

test('a hidden start value never shows up in events, and an empty answer keeps it', async () => {
  const variables = [{ name: 'TOKEN', value: 'vorgabe-geheim', secret: true, prompt: true }];
  const typed = await interactive([log('token ${TOKEN}')], () => ({ TOKEN: 'getippt-geheim' }), { variables });
  assert.equal(typed.prompts[0].fields[0].default, '');
  assert.equal(typed.run.getVar('TOKEN'), 'getippt-geheim');
  assert.ok(!JSON.stringify(typed.events).includes('geheim'));
  const kept = await interactive([], () => ({ TOKEN: '' }), { variables });
  assert.equal(kept.run.getVar('TOKEN'), 'vorgabe-geheim');
});

test('«Eingabe abfragen» stores the answer; without anyone to answer it uses the default', async () => {
  const ask = op('var.prompt', { message: 'Welche Version?', variable: 'VERSION', default: '1.0.0' });
  const asked = await interactive([ask, log('v${VERSION}')], () => ({ VERSION: '2.5.0' }));
  assert.equal(asked.result.status, 'success', asked.result.error);
  assert.equal(asked.prompts[0].message, 'Welche Version?');
  assert.ok(asked.messages.includes('v2.5.0'));
  assert.deepEqual(asked.events.filter((e) => e.type.startsWith('prompt')).map((e) => e.type), ['prompt', 'prompt-answered']);

  const unattended = await runMacro([ask, log('v${VERSION}')]);
  assert.equal(unattended.result.status, 'success');
  assert.ok(unattended.messages.includes('v1.0.0'));
});

test('«Eingabe abfragen» enforces choices and hides secret input', async () => {
  const choice = op('var.prompt', { message: 'Ziel?', variable: 'ZIEL', default: 'test', choices: 'test, produktion' });
  const wrong = await interactive([choice], () => ({ ZIEL: 'mond' }));
  assert.equal(wrong.result.status, 'failed');
  assert.match(wrong.result.error, /«mond» ist kein erlaubter Wert/);

  const secret = op('var.prompt', { message: 'Passwort?', variable: 'PASSWORT', secret: true });
  const hidden = await interactive([secret, log('pw ${PASSWORT}')], () => ({ PASSWORT: 'streng-geheim' }));
  assert.equal(hidden.run.getVar('PASSWORT'), 'streng-geheim');
  assert.ok(!JSON.stringify(hidden.events).includes('streng-geheim'));
  assert.ok(hidden.messages.includes('pw ***'));
});

test('«Bestätigung einholen»: yes continues, no fails or ends the macro', async () => {
  const confirm = (props = {}) => op('flow.confirm', { message: 'Wirklich veröffentlichen?', ...props }, { id: 'frage' });
  const yes = await interactive([confirm(), log('weiter')], () => true);
  assert.equal(yes.result.status, 'success');
  assert.ok(yes.messages.includes('weiter'));
  assert.equal(yes.prompts[0].kind, 'confirm');

  const no = await interactive([confirm(), log('nie')], () => false);
  assert.equal(no.result.status, 'failed');
  assert.equal(no.result.error, 'Abgelehnt.');
  assert.ok(!no.messages.includes('nie'));

  const quiet = await interactive([confirm({ onNo: 'stop' }), log('nie')], () => false);
  assert.equal(quiet.result.status, 'success');
  assert.ok(!quiet.messages.includes('nie'));
});

test('«Bestätigung einholen» without anyone to answer follows its setting', async () => {
  const proceed = await runMacro([op('flow.confirm', { message: 'Weiter?' }), log('weiter')]);
  assert.equal(proceed.result.status, 'success');
  assert.ok(proceed.messages.includes('weiter'));
  const strict = await runMacro([op('flow.confirm', { message: 'Weiter?', unattended: 'fail' }), log('nie')]);
  assert.equal(strict.result.status, 'failed');
});

test('stopping the run while a question is open cancels it', async () => {
  const { result, status } = await interactive([op('flow.confirm', { message: 'Weiter?' }, { id: 'frage' }), log('nie')], (event, run) => void run.stop());
  assert.equal(result.status, 'cancelled');
  assert.equal(status.frage, 'cancelled');
});

test('an answer to a question that is not waiting is refused', async () => {
  let late;
  await interactive([op('flow.confirm', { message: 'Weiter?' })], (event, run) => {
    setTimeout(() => (late = run.answer(event.promptId, true)), 20);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(late, false);
});

/** Feeds lines to askOnTerminal one at a time, each once its question has appeared. */
async function typeAnswers(event, answers) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk) => (shown += chunk));
  const pending = askOnTerminal(event, { input, output });
  for (const [question, line] of answers) {
    for (let i = 0; i < 200 && !shown.includes(question); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(shown.includes(question), `never asked «${question}»; shown: ${shown}`);
    input.write(`${line}\n`);
  }
  return { reply: await pending, shown };
}

test('terminal: a form takes typed values, and an empty line accepts the suggestion', async () => {
  const fields = [
    { name: 'CONFIG', label: 'Konfiguration', default: 'Release', choices: ['Debug', 'Release'], secret: false },
    { name: 'ZIEL', label: 'Zielordner', default: 'dist', choices: [], secret: false },
    { name: 'TOKEN', label: 'Token', default: '', choices: [], secret: true },
  ];
  const { reply, shown } = await typeAnswers({ kind: 'form', message: 'Mit welchen Werten?', fields }, [
    ['Konfiguration (Debug / Release) [Release]: ', 'Debug'],
    ['Zielordner [dist]: ', ''],
    ['Token: ', 'geheim'],
  ]);
  assert.deepEqual(reply, { CONFIG: 'Debug', ZIEL: 'dist', TOKEN: 'geheim' });
  assert.ok(shown.startsWith('Mit welchen Werten?\n'));
});

test('terminal: a confirmation understands yes and no', async () => {
  const confirm = { kind: 'confirm', message: 'Wirklich veröffentlichen?' };
  assert.equal((await typeAnswers(confirm, [['Wirklich veröffentlichen? (j/n) ', 'j']])).reply, true);
  assert.equal((await typeAnswers(confirm, [['(j/n) ', 'Ja']])).reply, true);
  assert.equal((await typeAnswers(confirm, [['(j/n) ', 'n']])).reply, false);
  assert.equal((await typeAnswers(confirm, [['(j/n) ', '']])).reply, false);
});

test('validation: the default of a variable with choices must be one of them', () => {
  const macro = (variables) => ({ format: 'buildwerk/1', name: 'x', variables, operations: [] });
  const systemNames = SYSTEM_VARIABLES.map((v) => v.name);
  assert.deepEqual(validateMacro(macro([config]), catalog, systemNames), []);
  assert.equal(validateMacro(macro([{ ...config, value: 'Anders' }]), catalog, systemNames).length, 1);
  assert.equal(validateMacro(macro([{ ...config, value: '' }]), catalog, systemNames).length, 1);
  assert.deepEqual(validateMacro(macro([{ name: 'A', value: 'Debug' }, { ...config, value: '${A}' }]), catalog, systemNames), []);
});

test('GitHub Actions export turns choices into a choice input', () => {
  const yaml = exportGithubActions({ name: 'x', variables: [config, { name: 'FREI', value: 'a' }], operations: [] }, { macroPath: 'x.buildwerk.json' });
  assert.match(yaml, /CONFIG:\n {8}description: 'Konfiguration'\n {8}required: false\n {8}type: choice\n {8}default: 'Release'\n {8}options:\n {10}- 'Debug'\n {10}- 'Release'\n/);
  // A variable without choices stays a free-text input with no type line.
  assert.match(yaml, /FREI:\n {8}description: 'FREI \(Standard: a\)'\n {8}required: false\n {2}push:/);
});
