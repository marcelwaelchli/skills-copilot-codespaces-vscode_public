// Right panel: properties of the selected operation, generated from the
// field descriptions in the catalog. Without a selection it shows the macro.

import { effectiveProps, isFieldVisible, walk } from '/shared/model.js';
import { PLAIN_TEXT, clear, h } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { defOf, mutate, on, selectedEntry, state, updateOp } from './store.js';

/** Every variable name a field could reference: declared, created by operations, built in. */
function knownVariables() {
  const user = (state.macro.variables || []).map((v) => v.name).filter(Boolean);
  const created = new Set();
  for (const { op } of walk(state.macro.operations)) {
    const def = defOf(op);
    if (!def) continue;
    const props = effectiveProps(def, op);
    for (const field of def.fields) if (field.type === 'variable' && props[field.key]) created.add(props[field.key]);
    for (const template of def.provides || []) created.add(template.replace(/\{(\w+)\}/g, (_, key) => props[key] ?? ''));
  }
  const runtime = [...created].filter((name) => !user.includes(name));
  return { user, runtime, system: state.info.systemVariables.map((v) => v.name) };
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 360)}px`;
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.setRangeText(text, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

/** Small «${x}» button that inserts a variable reference into its field. */
function variableButton(input) {
  return h(
    'button',
    {
      type: 'button',
      class: 'var-button',
      title: 'Variable einfügen',
      'aria-label': 'Variable einfügen',
      tabIndex: -1,
      onclick: (event) => {
        const { user, runtime, system } = knownVariables();
        const items = [];
        const section = (names) => {
          if (!names.length) return;
          if (items.length) items.push({ separator: true });
          for (const name of names) items.push({ label: name, icon: 'braces', onSelect: () => insertAtCursor(input, `\${${name}}`) });
        };
        section(user);
        section(runtime);
        section(system);
        const rect = event.currentTarget.getBoundingClientRect();
        showMenu(rect.left, rect.bottom + 4, items);
      },
    },
    '${x}',
  );
}

export function mountProps(root) {
  const advancedOpen = new Set();
  let renderedFor = null;
  let problemsBox = null;

  function fieldControl(field, value, onChange) {
    const id = `field-${field.key}`;
    const common = { id, dataset: { key: field.key }, placeholder: field.placeholder || '' };
    switch (field.type) {
      case 'checkbox':
        return h('input', { ...common, type: 'checkbox', checked: value === true || value === 'true', onchange: (e) => onChange(e.target.checked, true) });
      case 'select':
        return h(
          'select',
          { ...common, class: 'input', onchange: (e) => onChange(e.target.value, true) },
          field.options.map((option) => h('option', { value: option.value, selected: option.value === value }, option.label)),
        );
      case 'textarea':
      case 'code': {
        const textarea = h('textarea', {
          ...common,
          class: `input ${field.type === 'code' ? 'mono' : ''}`,
          rows: field.type === 'code' ? 4 : 2,
          attrs: PLAIN_TEXT,
          value: value ?? '',
          oninput: (e) => {
            autoGrow(e.target);
            onChange(e.target.value);
          },
        });
        queueMicrotask(() => autoGrow(textarea));
        return textarea;
      }
      case 'variable':
        return h('input', { ...common, type: 'text', class: 'input mono', list: 'bw-variables', attrs: PLAIN_TEXT, value: value ?? '', oninput: (e) => onChange(e.target.value.trim()) });
      default:
        return h('input', {
          ...common,
          type: 'text',
          class: `input ${field.type === 'path' ? 'mono' : ''}`,
          inputMode: field.type === 'number' ? 'decimal' : null,
          attrs: PLAIN_TEXT,
          value: value ?? '',
          oninput: (e) => onChange(e.target.value),
        });
    }
  }

  function fieldRow(field, value, onChange) {
    const control = fieldControl(field, value, onChange);
    if (field.type === 'checkbox') {
      return h('div', { class: 'field field-check' }, h('label', null, control, h('span', null, field.label)), field.hint && h('p', { class: 'hint' }, field.hint));
    }
    const acceptsVariables = ['text', 'path', 'textarea', 'code', 'number'].includes(field.type) && !field.raw;
    return h(
      'div',
      { class: 'field' },
      h('div', { class: 'field-label' }, h('label', { for: control.id }, field.label, field.required && h('span', { class: 'required', title: 'Pflichtfeld' }, ' *')), acceptsVariables && variableButton(control)),
      control,
      field.hint && h('p', { class: 'hint' }, field.hint),
    );
  }

  function renderProblems() {
    if (!problemsBox) return;
    const problems = state.selection ? state.problemsByOp.get(state.selection) || [] : state.problems.filter((p) => !p.opId);
    clear(problemsBox);
    for (const problem of problems) {
      problemsBox.append(h('div', { class: `notice ${problem.level}` }, icon('alert', 14), h('span', null, problem.message)));
    }
  }

  function renderOperation(op) {
    const def = defOf(op);
    if (!def) {
      root.append(h('div', { class: 'panel-head' }, h('h2', null, 'Eigenschaften')), h('div', { class: 'props-body' }, h('div', { class: 'notice error' }, icon('alert', 14), h('span', null, `Unbekannter Operationstyp «${op.type}».`))));
      return;
    }
    const props = effectiveProps(def, op);
    const set = (key) => (value, structural) =>
      updateOp(op.id, (target) => (target.props[key] = value), { coalesce: `${op.id}:${key}`, source: structural ? 'props-structural' : 'props' });

    const visible = def.fields.filter((field) => isFieldVisible(field, props));
    const basic = visible.filter((field) => field.group !== 'advanced');
    const advanced = visible.filter((field) => field.group === 'advanced');
    // Open «Erweitert» on its own when something in there differs from the default.
    const advancedUsed = advanced.some((field) => (op.props?.[field.key] ?? '') !== '' && op.props[field.key] !== field.default);

    problemsBox = h('div', { class: 'notices' });
    root.append(
      h('div', { class: 'panel-head' }, h('h2', null, 'Eigenschaften')),
      h(
        'div',
        { class: 'props-body' },
        h('div', { class: 'props-title' }, h('span', { class: `badge large cat-${def.category}` }, icon(def.icon, 18)), h('div', null, h('h3', null, def.label), h('p', null, def.description))),
        problemsBox,
        fieldRow({ key: '__name', label: 'Name', type: 'text', raw: true, placeholder: def.label, hint: 'Eigene Bezeichnung im Baum und im Protokoll.' }, op.name, (value) =>
          updateOp(op.id, (target) => (value ? (target.name = value) : delete target.name), { coalesce: `${op.id}:name`, source: 'props' })),
        basic.map((field) => fieldRow(field, props[field.key], set(field.key))),
        advanced.length > 0 &&
          h(
            'details',
            { class: 'advanced', open: advancedUsed || advancedOpen.has(def.type), ontoggle: (e) => (e.target.open ? advancedOpen.add(def.type) : advancedOpen.delete(def.type)) },
            h('summary', null, 'Erweitert'),
            advanced.map((field) => fieldRow(field, props[field.key], set(field.key))),
          ),
        h('div', { class: 'props-section' }, 'Verhalten'),
        fieldRow(
          {
            key: '__onError',
            label: 'Bei einem Fehler',
            type: 'select',
            options: [
              { value: 'stop', label: 'Makro abbrechen' },
              { value: 'continue', label: 'Fehler ignorieren und fortfahren' },
            ],
          },
          op.onError || 'stop',
          (value) => updateOp(op.id, (target) => (value === 'continue' ? (target.onError = 'continue') : delete target.onError)),
        ),
        fieldRow({ key: '__note', label: 'Notiz', type: 'textarea', raw: true, placeholder: 'Wozu dient dieser Schritt?' }, op.note, (value) =>
          updateOp(op.id, (target) => (value ? (target.note = value) : delete target.note), { coalesce: `${op.id}:note`, source: 'props' })),
      ),
    );
  }

  function renderMacro() {
    const macro = state.macro;
    const set = (key) => (value) => mutate((target) => (target[key] = value), { coalesce: `macro:${key}`, source: 'props' });
    problemsBox = h('div', { class: 'notices' });
    root.append(
      h('div', { class: 'panel-head' }, h('h2', null, 'Makro')),
      h(
        'div',
        { class: 'props-body' },
        problemsBox,
        fieldRow({ key: 'name', label: 'Name', type: 'text', raw: true }, macro.name, set('name')),
        fieldRow({ key: 'description', label: 'Beschreibung', type: 'textarea', raw: true }, macro.description, set('description')),
        fieldRow(
          { key: 'baseDir', label: 'Basisverzeichnis', type: 'path', raw: true, placeholder: '.', hint: 'Relative Pfade und Befehle beziehen sich auf diesen Ordner, ausgehend vom Speicherort der Makrodatei.' },
          macro.baseDir,
          set('baseDir'),
        ),
        h('div', { class: 'props-section' }, 'Tastenkürzel'),
        h(
          'dl',
          { class: 'shortcuts' },
          [
            ['F5', 'Ausführen / Fortsetzen'],
            ['Umschalt+F5', 'Stoppen'],
            ['F10', 'Einzelschritt'],
            ['F9', 'Haltepunkt'],
            ['Strg+S', 'Speichern'],
            ['Alt+↑ ↓', 'Operation verschieben'],
            ['Alt+← →', 'Aus Block heraus / hinein'],
            ['Leertaste', 'Aktivieren / Deaktivieren'],
            ['Entf', 'Löschen'],
          ].map(([keys, text]) => [h('dt', null, h('kbd', null, keys)), h('dd', null, text)]),
        ),
      ),
    );
  }

  function render({ keepFocus = false } = {}) {
    const focusedKey = keepFocus ? root.querySelector(':focus')?.dataset.key : null;
    clear(root);
    // Suggestions for fields that take a variable name.
    const { user, runtime } = knownVariables();
    root.append(h('datalist', { id: 'bw-variables' }, [...user, ...runtime].map((name) => h('option', { value: name }))));
    const entry = selectedEntry();
    renderedFor = entry?.op.id || null;
    if (entry) renderOperation(entry.op);
    else renderMacro();
    renderProblems();
    if (focusedKey) root.querySelector(`[data-key="${focusedKey}"]`)?.focus();
  }

  on('selection', () => {
    if (renderedFor !== state.selection) render();
  });
  on('macro', ({ source }) => {
    // Typing in this panel must not rebuild it, or the cursor would jump.
    if (source === 'props') return renderProblems();
    if (source === 'collapse' || source === 'breakpoint') return;
    render({ keepFocus: source === 'props-structural' });
  });

  render();
}
