// Questions a running macro asks: start values, input and confirmation.

import { api } from './api.js';
import { PLAIN_TEXT, h } from './dom.js';
import { openDialog, toast } from './menu.js';
import { control, onRunEvent } from './runner.js';
import { state } from './store.js';

const DISMISSED = Symbol('dismissed');
let current = null; // { promptId, dialog }

function reply(promptId, value) {
  return api.post(`/api/runs/${state.run.id}/control`, { answer: { promptId, value } }).catch((error) => toast(error.message, 'error'));
}

function fieldControl(field) {
  const common = { id: `prompt-${field.name}`, dataset: { name: field.name } };
  if (field.choices.length) {
    return h('select', { ...common, class: 'input' }, field.choices.map((choice) => h('option', { value: choice, selected: choice === field.default }, choice)));
  }
  return h('input', {
    ...common,
    type: field.secret ? 'password' : 'text',
    class: 'input mono',
    attrs: PLAIN_TEXT,
    value: field.default ?? '',
    placeholder: field.secret ? 'leer lassen, um den Wert zu behalten' : '',
  });
}

async function show(event) {
  const track = (dialog) => (current = { promptId: event.promptId, dialog });
  let result;

  if (event.kind === 'confirm') {
    result = await openDialog({
      title: event.title || 'Bestätigung',
      width: '440px',
      onCreate: track,
      body: h('p', { class: 'prompt-message' }, event.message),
      buttons: [
        { label: 'Nein', value: false },
        { label: 'Ja', value: true, primary: true },
      ],
    });
    if (current?.promptId === event.promptId) current = null;
    if (result === DISMISSED) return;
    // Closing the dialog without choosing counts as «no».
    return reply(event.promptId, result === true);
  }

  const controls = event.fields.map((field) => ({ field, control: fieldControl(field) }));
  result = await openDialog({
    title: event.title || 'Eingabe',
    width: '480px',
    onCreate: track,
    body: [
      event.message && h('p', { class: 'prompt-message' }, event.message),
      controls.map(({ field, control: input }) => h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('label', { for: input.id }, field.label)), input)),
    ],
    buttons: [
      { label: 'Makro stoppen', value: 'stop', danger: true },
      { label: 'Weiter', value: 'ok', primary: true },
    ],
  });
  if (current?.promptId === event.promptId) current = null;
  if (result === DISMISSED) return;
  if (result !== 'ok') return control('stop');
  return reply(event.promptId, Object.fromEntries(controls.map(({ field, control: input }) => [field.name, input.value])));
}

export function mountPrompts() {
  onRunEvent((event) => {
    if (event.type === 'prompt') {
      show(event);
    } else if ((event.type === 'prompt-answered' && current?.promptId === event.promptId) || event.type === 'run-end') {
      // Answered elsewhere (another window) or the run ended: the question is moot.
      current?.dialog.close_(DISMISSED);
      current = null;
    }
  });
}
