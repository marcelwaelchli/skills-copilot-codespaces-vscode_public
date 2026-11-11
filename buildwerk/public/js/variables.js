// Centre panel, second tab: the macro's variables.

import { PLAIN_TEXT, append, button, clear, h } from './dom.js';
import { icon } from './icons.js';
import { mutate, on, state } from './store.js';

export function mountVariables(root) {
  const body = h('div', { class: 'vars' });
  const notices = h('div', { class: 'notices' });
  root.append(body);

  function renderNotices() {
    append(
      clear(notices),
      state.problems.filter((p) => !p.opId).map((problem) => h('div', { class: `notice ${problem.level}` }, icon('alert', 14), h('span', null, problem.message))),
    );
  }

  function edit(index, key, value, structural = false) {
    mutate((macro) => (macro.variables[index][key] = value), { coalesce: `var:${index}:${key}`, source: structural ? 'vars-structural' : 'vars' });
  }

  function row(variable, index) {
    const text = (key, extra = {}) =>
      h('input', { type: 'text', class: 'input', attrs: PLAIN_TEXT, value: variable[key] ?? '', dataset: { key: `${index}:${key}` }, oninput: (e) => edit(index, key, e.target.value), ...extra });
    const flag = (key, title) =>
      h('input', { type: 'checkbox', checked: Boolean(variable[key]), title, 'aria-label': title, onchange: (e) => edit(index, key, e.target.checked, true) });
    return h(
      'tr',
      null,
      h('td', null, text('name', { class: 'input mono', placeholder: 'NAME' })),
      h('td', null, text('value', { class: 'input mono', type: variable.secret ? 'password' : 'text', placeholder: variable.secret ? 'aus Umgebungsvariable' : '' })),
      h('td', null, text('description')),
      h('td', { class: 'center' }, flag('secret', 'Geheim: Wert wird im Protokoll verborgen')),
      h('td', { class: 'center' }, flag('persistent', 'Persistent: Wert bleibt zwischen den Läufen erhalten')),
      h('td', null, h('button', { type: 'button', class: 'btn ghost icon-only', title: 'Variable löschen', onclick: () => mutate((macro) => macro.variables.splice(index, 1)) }, icon('trash', 15))),
    );
  }

  function render({ focusLast = false } = {}) {
    const focusedKey = body.querySelector(':focus')?.dataset.key;
    const variables = state.macro.variables || [];
    renderNotices();
    append(clear(body), [
      notices,
      variables.length
        ? h(
            'table',
            { class: 'vars-table' },
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Standardwert'), h('th', null, 'Beschreibung'), h('th', { class: 'center', title: 'Wert wird im Protokoll verborgen' }, 'Geheim'), h('th', { class: 'center', title: 'Wert bleibt zwischen den Läufen erhalten' }, 'Persistent'), h('th', null))),
            h('tbody', null, variables.map(row)),
          )
        : h('p', { class: 'empty-note' }, 'Dieses Makro hat noch keine Variablen. Variablen werden überall als ${NAME} eingesetzt und stehen Skripten als Umgebungsvariablen zur Verfügung.'),
      h(
        'div',
        { class: 'vars-actions' },
        button({
          icon: 'plus',
          label: 'Variable hinzufügen',
          onClick: () => {
            mutate((macro) => macro.variables.push({ name: '', value: '', description: '' }), { source: 'vars-add' });
          },
        }),
      ),
      h(
        'ul',
        { class: 'vars-help' },
        h('li', null, h('strong', null, 'Geheim: '), 'Der Wert erscheint im Protokoll als ***. Bleibt der Standardwert leer, wird die gleichnamige Umgebungsvariable verwendet – so landet kein Passwort in der Makrodatei.'),
        h('li', null, h('strong', null, 'Persistent: '), 'Der Wert am Ende eines Laufs ist der Startwert des nächsten, etwa für eine fortlaufende Build-Nummer. Gespeichert wird er neben dem Makro in einer .state.json-Datei.'),
      ),
      h(
        'details',
        { class: 'system-vars' },
        h('summary', null, 'Systemvariablen'),
        h('table', { class: 'vars-table readonly' }, h('tbody', null, state.info.systemVariables.map((v) => h('tr', null, h('td', { class: 'mono' }, `\${${v.name}}`), h('td', null, v.description))))),
      ),
    ]);
    if (focusLast) body.querySelector('tbody tr:last-child input')?.focus();
    else if (focusedKey) body.querySelector(`[data-key="${focusedKey}"]`)?.focus();
  }

  on('macro', ({ source }) => {
    if (source === 'vars') return renderNotices(); // typing here: keep the inputs as they are
    if (state.view === 'vars' || source === 'document' || source === 'history') render({ focusLast: source === 'vars-add' });
  });
  on('view', () => state.view === 'vars' && render());
  render();
}
