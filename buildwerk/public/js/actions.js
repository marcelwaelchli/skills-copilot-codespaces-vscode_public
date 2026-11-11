// Document-level actions: new, open, save, templates, export and run control.

import { exportGithubActions, suggestWorkflowPath } from '/shared/export-gha.js';
import { MACRO_EXTENSION, cloneOp, createMacro } from '/shared/model.js';
import { api } from './api.js';
import { PLAIN_TEXT, clear, h, storageSet } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, openDialog, toast } from './menu.js';
import * as runner from './runner.js';
import { isDirty, isRunning, markSaved, setBottomTab, setDocument, setView, state } from './store.js';

function report(error) {
  toast(error.message || String(error), 'error');
}

async function confirmDiscard() {
  if (!isDirty()) return true;
  return confirmDialog({
    title: 'Ungespeicherte Änderungen',
    message: `«${state.macro.name || 'Unbenannt'}» wurde geändert. Sollen die Änderungen verworfen werden?`,
    okLabel: 'Verwerfen',
    danger: true,
  });
}

function slug(name) {
  return (
    String(name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'makro'
  );
}

export async function newMacro() {
  if (!(await confirmDiscard())) return;
  setDocument(createMacro(), null);
  setView('ops');
  storageSet('bw:last', '');
}

export async function loadTemplate(file) {
  if (!(await confirmDiscard())) return;
  try {
    const macro = await api.get(`/api/template?file=${encodeURIComponent(file)}`);
    macro.operations = (macro.operations || []).map(cloneOp);
    setDocument(macro, null);
    setView('ops');
  } catch (error) {
    report(error);
  }
}

export async function chooseTemplate() {
  let templates = [];
  try {
    templates = await api.get('/api/templates');
  } catch (error) {
    return report(error);
  }
  const choice = (label, description, value, iconName) =>
    h('button', { type: 'button', class: 'choice', onclick: (event) => event.target.closest('dialog').close_(value) }, h('span', { class: 'choice-icon' }, icon(iconName, 18)), h('span', null, h('strong', null, label), h('small', null, description)));
  const picked = await openDialog({
    title: 'Neues Makro',
    width: '520px',
    body: h(
      'div',
      { class: 'choices' },
      choice('Leeres Makro', 'Mit einer leeren Arbeitsfläche beginnen.', '', 'fileplus'),
      templates.map((template) => choice(template.name, template.description, template.file, 'layers')),
    ),
  });
  if (picked === '') return newMacro();
  if (picked) return loadTemplate(picked);
}

export async function openPath(path, { silent = false } = {}) {
  try {
    const macro = await api.get(`/api/macro?path=${encodeURIComponent(path)}`);
    setDocument(macro, path);
    setView('ops');
    storageSet('bw:last', path);
    return true;
  } catch (error) {
    if (!silent) report(error);
    return false;
  }
}

export async function openMacro() {
  if (!(await confirmDiscard())) return;
  let macros = [];
  try {
    macros = await api.get('/api/macros');
  } catch (error) {
    return report(error);
  }
  const list = h('div', { class: 'file-list' });
  const filter = h('input', { type: 'search', class: 'input', placeholder: 'Filtern …', attrs: PLAIN_TEXT, oninput: () => render() });
  function render() {
    const query = filter.value.trim().toLowerCase();
    clear(list);
    const shown = macros.filter((m) => !query || m.name.toLowerCase().includes(query) || m.path.toLowerCase().includes(query));
    for (const macro of shown) {
      list.append(
        h('button', { type: 'button', class: 'file-row', onclick: (event) => event.target.closest('dialog').close_(macro.path) }, icon('file', 15), h('span', { class: 'name' }, macro.name), h('span', { class: 'path' }, macro.path)),
      );
    }
    if (!shown.length) {
      list.append(h('p', { class: 'empty-note' }, macros.length ? 'Kein Makro passt zum Filter.' : `Im Arbeitsbereich liegt noch kein Makro (*${MACRO_EXTENSION}).`));
    }
  }
  render();
  const path = await openDialog({ title: 'Makro öffnen', width: '560px', body: [filter, list], buttons: [{ label: 'Abbrechen', value: null }] });
  if (typeof path === 'string') await openPath(path);
}

async function write(path) {
  await api.put(`/api/macro?path=${encodeURIComponent(path)}`, state.macro);
  markSaved(path);
  storageSet('bw:last', path);
  toast(`Gespeichert: ${path}`);
  return true;
}

export async function saveAs() {
  const input = h('input', { type: 'text', class: 'input mono', attrs: PLAIN_TEXT, value: state.path || `${slug(state.macro.name)}${MACRO_EXTENSION}` });
  const ok = await openDialog({
    title: 'Makro speichern',
    width: '480px',
    body: [
      h('label', { class: 'dialog-label', for: 'save-path' }, 'Dateipfad im Arbeitsbereich'),
      Object.assign(input, { id: 'save-path' }),
      h('p', { class: 'hint' }, `Arbeitsbereich: ${state.info.workspace}`),
    ],
    buttons: [
      { label: 'Abbrechen', value: false },
      { label: 'Speichern', value: true, primary: true },
    ],
  });
  if (ok !== true) return false;
  let path = input.value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path) return false;
  if (!path.endsWith(MACRO_EXTENSION)) path = path.replace(/(\.json)?$/, '') + MACRO_EXTENSION;
  try {
    if (path !== state.path && (await api.get('/api/macros')).some((macro) => macro.path === path)) {
      const overwrite = await confirmDialog({ title: 'Datei existiert bereits', message: `«${path}» überschreiben?`, okLabel: 'Überschreiben', danger: true });
      if (!overwrite) return false;
    }
    return await write(path);
  } catch (error) {
    report(error);
    return false;
  }
}

export async function save() {
  if (!state.path) return saveAs();
  try {
    return await write(state.path);
  } catch (error) {
    report(error);
    return false;
  }
}

export async function exportWorkflow() {
  if (!state.path || isDirty()) {
    const proceed = await confirmDialog({
      title: 'Erst speichern',
      message: 'Der Workflow führt die gespeicherte Makrodatei aus. Das Makro wird deshalb zuerst gespeichert.',
      okLabel: 'Speichern und weiter',
    });
    if (!proceed || !(await save())) return;
  }
  const { repo } = state.info;
  const macroPath = (repo.prefix ? `${repo.prefix}/` : '') + state.path;
  const branch = h('input', { type: 'text', class: 'input mono', attrs: PLAIN_TEXT, value: 'main', oninput: () => update() });
  const target = h('input', { type: 'text', class: 'input mono', attrs: PLAIN_TEXT, value: suggestWorkflowPath(state.macro) });
  const preview = h('textarea', { class: 'input mono preview', readOnly: true, rows: 18, attrs: PLAIN_TEXT });
  const update = () => (preview.value = exportGithubActions(state.macro, { macroPath, toolPath: repo.toolPath ?? 'buildwerk', branch: branch.value.trim() || 'main' }));
  update();
  await openDialog({
    title: 'Als GitHub-Actions-Workflow exportieren',
    width: '720px',
    body: [
      h('p', { class: 'dialog-text' }, 'Der Workflow startet dieses Makro bei jedem Push und auf Knopfdruck. Geheime Variablen kommen aus den Repository-Secrets gleichen Namens.'),
      repo.toolPath === null && h('div', { class: 'notice warning' }, icon('alert', 14), h('span', null, 'Buildwerk liegt ausserhalb dieses Repositorys. Der Workflow erwartet es im Ordner «buildwerk» – bitte den Pfad anpassen oder Buildwerk ins Repository legen.')),
      h('div', { class: 'grid-2' }, h('div', null, h('label', { class: 'dialog-label' }, 'Auslösender Branch'), branch), h('div', null, h('label', { class: 'dialog-label' }, 'Workflow-Datei'), target)),
      preview,
    ],
    buttons: [
      { label: 'Schliessen', value: null },
      {
        label: 'Kopieren',
        keepOpen: true,
        onClick: () => navigator.clipboard?.writeText(preview.value).then(() => toast('Workflow kopiert'), () => toast('Kopieren nicht möglich', 'error')),
      },
      {
        label: 'Im Repository speichern',
        primary: true,
        onClick: async () => {
          try {
            await api.post('/api/export/save', { path: target.value.trim(), content: preview.value });
            toast(`Workflow gespeichert: ${target.value.trim()}`);
            return true;
          } catch (error) {
            report(error);
            return false;
          }
        },
      },
    ],
  });
}

// --------------------------------------------------------------------- run

export async function run(options = {}) {
  if (isRunning()) return;
  if (state.problems.some((problem) => problem.level === 'error')) {
    setBottomTab('problems');
    return toast('Das Makro enthält Fehler – bitte zuerst beheben.', 'error');
  }
  setBottomTab('log');
  try {
    await runner.start(options);
  } catch (error) {
    report(error);
  }
}

/** F5: start, or continue when paused. */
export function runOrResume() {
  return state.run.phase === 'paused' ? runner.control('resume').catch(report) : run();
}

/** F10: next step when paused, otherwise start and pause before the first operation. */
export function step() {
  if (state.run.phase === 'paused') return runner.control('step').catch(report);
  if (state.run.phase === 'running') return runner.control('pause').catch(report);
  return run({ paused: true });
}

export const stop = () => runner.control('stop').catch(report);
export const pause = () => runner.control('pause').catch(report);
