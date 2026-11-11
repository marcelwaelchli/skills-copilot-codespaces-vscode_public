// Entry point: builds the window frame and wires the panels together.

import { formatDuration } from '/shared/model.js';
import * as actions from './actions.js';
import { api } from './api.js';
import { mountBottom } from './bottom.js';
import { append, button, clear, h, storageGet, storageSet, throttleFrame } from './dom.js';
import { icon } from './icons.js';
import { mountPalette } from './palette.js';
import { mountProps } from './props.js';
import * as runner from './runner.js';
import {
  canRedo, canUndo, duplicateOp, indentOp, init, isDirty, isRunning, on, outdentOp, redo, removeOp, setAllCollapsed, setBottomTab, setView,
  shiftOp, state, toggleBreakpoint, undo,
} from './store.js';
import { mountTree } from './tree.js';
import { mountVariables } from './variables.js';

const $ = (selector) => document.querySelector(selector);

// ------------------------------------------------------------------ top bar

function renderTopbar() {
  const { phase } = state.run;
  const running = isRunning();
  const controls =
    phase === 'paused'
      ? [
          button({ icon: 'play', label: 'Weiter', title: 'Fortsetzen (F5)', kind: 'primary', onClick: actions.runOrResume }),
          button({ icon: 'step', label: 'Schritt', title: 'Nächste Operation ausführen (F10)', onClick: actions.step }),
          button({ icon: 'stop', label: 'Stopp', title: 'Abbrechen (Umschalt+F5)', kind: 'danger', onClick: actions.stop }),
        ]
      : phase === 'running'
        ? [
            button({ icon: 'pause', label: 'Pause', title: 'Vor der nächsten Operation anhalten (F10)', onClick: actions.pause }),
            button({ icon: 'stop', label: 'Stopp', title: 'Abbrechen (Umschalt+F5)', kind: 'danger', onClick: actions.stop }),
          ]
        : [
            button({ icon: 'play', label: 'Ausführen', title: 'Makro ausführen (F5)', kind: 'primary', onClick: () => actions.run() }),
            button({ icon: 'step', title: 'Schrittweise ausführen (F10)', kind: 'icon-only', onClick: actions.step }),
          ];

  append(clear($('#topbar')), [
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: 22, height: 22 }), h('span', null, 'Buildwerk')),
    h(
      'div',
      { class: 'toolbar' },
      button({ icon: 'fileplus', label: 'Neu', title: 'Neues Makro oder Vorlage', onClick: actions.chooseTemplate, disabled: running }),
      button({ icon: 'folder', label: 'Öffnen', title: 'Makro öffnen (Strg+O)', onClick: actions.openMacro, disabled: running }),
      button({ icon: 'save', label: 'Speichern', title: 'Speichern (Strg+S)', onClick: actions.save }),
      h('span', { class: 'divider' }),
      button({ icon: 'undo', title: 'Rückgängig (Strg+Z)', kind: 'icon-only', onClick: undo, disabled: !canUndo() }),
      button({ icon: 'redo', title: 'Wiederholen (Strg+Y)', kind: 'icon-only', onClick: redo, disabled: !canRedo() }),
    ),
    h(
      'div',
      { class: 'doc-title', title: state.path || 'Noch nicht gespeichert' },
      h('strong', null, state.macro.name || 'Unbenannt'),
      isDirty() && h('span', { class: 'dirty', title: 'Ungespeicherte Änderungen' }),
      h('span', { class: 'path' }, state.path || 'nicht gespeichert'),
    ),
    h('div', { class: 'toolbar' }, controls),
    h(
      'div',
      { class: 'toolbar' },
      button({ icon: 'send', label: 'Export', title: 'Als GitHub-Actions-Workflow exportieren', onClick: actions.exportWorkflow }),
      button({
        icon: document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon',
        title: 'Helles / dunkles Design',
        kind: 'icon-only',
        onClick: () => {
          const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
          document.documentElement.dataset.theme = next;
          storageSet('bw:theme', next);
          renderTopbar();
        },
      }),
    ),
  ]);
  document.title = `${isDirty() ? '● ' : ''}${state.macro.name || 'Unbenannt'} – Buildwerk`;
}

// ------------------------------------------------------------------- editor

function mountEditor() {
  const head = h('div', { class: 'panel-head' });
  const treePane = h('div', { class: 'editor-pane' });
  const varsPane = h('div', { class: 'editor-pane scroll' });
  $('#editor').append(head, treePane, varsPane);
  const tree = mountTree(treePane);
  mountVariables(varsPane);

  function renderHead() {
    let count = 0;
    (function visit(ops) {
      for (const op of ops) {
        count++;
        if (op.children) visit(op.children);
      }
    })(state.macro.operations);
    const tab = (id, label, number) =>
      h('button', { type: 'button', class: `tab ${state.view === id ? 'active' : ''}`, role: 'tab', 'aria-selected': String(state.view === id), onclick: () => setView(id) }, label, h('span', { class: 'count' }, number));
    const selected = Boolean(state.selection);
    append(clear(head), [
      h('div', { class: 'tabs', role: 'tablist' }, tab('ops', 'Operationen', count), tab('vars', 'Variablen', state.macro.variables.length)),
      state.view === 'ops' &&
        h(
          'div',
          { class: 'tools' },
          button({ icon: 'expand', title: 'Alle Blöcke ausklappen', kind: 'ghost icon-only', onClick: () => setAllCollapsed(false) }),
          button({ icon: 'collapse', title: 'Alle Blöcke einklappen', kind: 'ghost icon-only', onClick: () => setAllCollapsed(true) }),
          h('span', { class: 'divider' }),
          button({ icon: 'arrowup', title: 'Nach oben (Alt+↑)', kind: 'ghost icon-only', disabled: !selected, onClick: () => shiftOp(-1) }),
          button({ icon: 'arrowdown', title: 'Nach unten (Alt+↓)', kind: 'ghost icon-only', disabled: !selected, onClick: () => shiftOp(1) }),
          button({ icon: 'arrowleft', title: 'Aus dem Block heraus (Alt+←)', kind: 'ghost icon-only', disabled: !selected, onClick: () => outdentOp() }),
          button({ icon: 'arrowright', title: 'In den Block darüber (Alt+→)', kind: 'ghost icon-only', disabled: !selected, onClick: () => indentOp() }),
          h('span', { class: 'divider' }),
          button({ icon: 'copy', title: 'Duplizieren (Strg+D)', kind: 'ghost icon-only', disabled: !selected, onClick: () => duplicateOp() }),
          button({ icon: 'trash', title: 'Löschen (Entf)', kind: 'ghost icon-only', disabled: !selected, onClick: () => removeOp() }),
        ),
    ]);
    treePane.hidden = state.view !== 'ops';
    varsPane.hidden = state.view !== 'vars';
  }

  on('macro', ({ source }) => source !== 'collapse' && source !== 'breakpoint' && renderHead());
  on('selection', renderHead);
  on('view', renderHead);
  renderHead();
  return tree;
}

// --------------------------------------------------------------- status bar

/** The last two folders of a path say where you are; the full path is in the tooltip. */
function shortPath(fullPath) {
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : fullPath;
}

function renderStatus() {
  const { phase, status, currentLabel, durationMs } = state.run;
  let kind = 'idle';
  let text = 'Bereit';
  if (phase === 'running') [kind, text] = ['running', currentLabel ? `Läuft: ${currentLabel}` : 'Läuft …'];
  else if (phase === 'paused') [kind, text] = ['paused', 'Angehalten – F5 setzt fort, F10 führt einen Schritt aus'];
  else if (phase === 'done' && status === 'success') [kind, text] = ['success', `Erfolgreich in ${formatDuration(durationMs)}`];
  else if (phase === 'done' && status === 'cancelled') [kind, text] = ['paused', 'Abgebrochen'];
  else if (phase === 'done') [kind, text] = ['failed', `Fehlgeschlagen nach ${formatDuration(durationMs)}`];

  const errors = state.problems.filter((p) => p.level === 'error').length;
  const warnings = state.problems.length - errors;
  append(clear($('#statusbar')), [
    h('span', { class: `run-state ${kind}` }, h('span', { class: 'dot' }), h('span', { class: 'text' }, text)),
    h('span', { class: 'spacer' }),
    state.problems.length > 0 &&
      h('button', { type: 'button', class: 'status-link', onclick: () => setBottomTab('problems') }, icon('alert', 12), `${errors} Fehler, ${warnings} ${warnings === 1 ? 'Warnung' : 'Warnungen'}`),
    h('span', { class: 'workspace', title: `Arbeitsbereich: ${state.info.workspace}` }, icon('folder', 12), shortPath(state.info.workspace)),
    h('span', null, `v${state.info.version}`),
  ]);
}

// ---------------------------------------------------------------- splitters

function setupSplitters() {
  const app = $('#app');
  const limits = { left: [170, 420], right: [240, 560], bottom: [90, 700] };
  for (const key of Object.keys(limits)) {
    const stored = Number(storageGet(`bw:size-${key}`));
    if (stored) app.style.setProperty(`--size-${key}`, `${stored}px`);
  }
  for (const splitter of document.querySelectorAll('.splitter')) {
    const key = splitter.dataset.resize;
    splitter.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('active');
      const start = key === 'bottom' ? event.clientY : event.clientX;
      const initial = parseFloat(getComputedStyle(app).getPropertyValue(`--size-${key}`));
      const move = (e) => {
        const delta = (key === 'bottom' ? e.clientY : e.clientX) - start;
        const size = Math.max(limits[key][0], Math.min(limits[key][1], initial + (key === 'left' ? delta : -delta)));
        app.style.setProperty(`--size-${key}`, `${size}px`);
      };
      const up = () => {
        splitter.classList.remove('active');
        splitter.removeEventListener('pointermove', move);
        storageSet(`bw:size-${key}`, parseFloat(getComputedStyle(app).getPropertyValue(`--size-${key}`)));
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up, { once: true });
      splitter.addEventListener('pointercancel', up, { once: true });
    });
  }
}

// ----------------------------------------------------------------- shortcuts

function setupShortcuts(tree) {
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    const run = (fn) => {
      event.preventDefault();
      fn();
    };
    if (event.key === 'F5') return run(event.shiftKey ? actions.stop : actions.runOrResume);
    if (event.key === 'F10') return run(actions.step);
    if (event.key === 'F9') return run(() => toggleBreakpoint());
    if (mod && key === 's') return run(event.shiftKey ? actions.saveAs : actions.save);
    if (mod && key === 'o') return run(actions.openMacro);
    if (typing) return; // text fields keep their own undo and editing keys
    if (mod && key === 'z') return run(event.shiftKey ? redo : undo);
    if (mod && key === 'y') return run(redo);
    if (event.key === 'Escape') tree.focus();
  });
}

// -------------------------------------------------------------------- start

async function main() {
  let info;
  try {
    info = await api.get('/api/info');
  } catch (error) {
    document.body.replaceChildren(h('div', { class: 'fatal' }, h('h1', null, 'Buildwerk ist nicht erreichbar'), h('p', null, error.message), h('p', null, 'Läuft der Server noch? Starte ihn mit «buildwerk serve» und lade die Seite neu.')));
    return;
  }
  init(info);

  mountPalette($('#palette'));
  const tree = mountEditor();
  mountProps($('#props'));
  mountBottom($('#bottom'));
  setupSplitters();
  setupShortcuts(tree);

  const refreshFrame = throttleFrame(() => {
    renderTopbar();
    renderStatus();
  });
  on('doc', refreshFrame);
  on('run', refreshFrame);
  on('macro', refreshFrame);
  renderTopbar();
  renderStatus();

  window.addEventListener('beforeunload', (event) => {
    if (isDirty()) event.preventDefault();
  });

  const last = storageGet('bw:last');
  if (last) await actions.openPath(last, { silent: true });
  if (info.activeRun) runner.attach(info.activeRun);
  tree.focus();
}

main();
