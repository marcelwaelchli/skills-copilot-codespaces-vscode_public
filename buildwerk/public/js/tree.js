// Centre panel: the macro as a tree of operations with drag & drop,
// keyboard editing, run status and breakpoints.

import { cloneOp, contains, findOp, formatDuration, opTitle, summarize } from '/shared/model.js';
import * as actions from './actions.js';
import { button, clear, h, throttleFrame } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import {
  addOp, copyOp, cutOp, defOf, duplicateOp, indentOp, insertOp, isRunning, moveOp, on, outdentOp, pasteOp, removeOp, select,
  selectedEntry, shiftOp, state, toggleBreakpoint, toggleCollapsed, toggleEnabled, visibleEntries, wrapInGroup,
} from './store.js';

const STATUS_ICON = {
  success: 'checkcircle',
  failed: 'xcircle',
  warning: 'alert',
  skipped: 'minuscircle',
  cancelled: 'stop',
};
const STATUS_TEXT = {
  running: 'läuft',
  success: 'erfolgreich',
  failed: 'fehlgeschlagen',
  warning: 'Fehler ignoriert',
  skipped: 'übersprungen',
  cancelled: 'abgebrochen',
};

export function mountTree(root) {
  const list = h('div', { class: 'tree', tabIndex: 0, role: 'tree', 'aria-label': 'Operationen des Makros' });
  root.append(list);
  let dropTarget = null;

  // ---------------------------------------------------------------- render

  function renderRow({ op, depth }) {
    const def = defOf(op);
    const isBlock = Boolean(op.children);
    const collapsed = state.collapsed.has(op.id);
    const status = state.run.opStatus.get(op.id);
    const problems = state.problemsByOp.get(op.id) || [];
    const worst = problems.some((p) => p.level === 'error') ? 'error' : problems.length ? 'warning' : null;
    const hasBreakpoint = state.breakpoints.has(op.id);
    const paused = state.run.pausedOp === op.id;

    const classes = ['row'];
    if (state.selection === op.id) classes.push('selected');
    if (op.enabled === false) classes.push('disabled');
    if (status) classes.push(`is-${status.status}`);
    if (paused) classes.push('paused');
    if (hasBreakpoint) classes.push('has-breakpoint');

    const summary = def ? summarize(def, op) : '';
    return h(
      'div',
      {
        class: classes.join(' '),
        draggable: true,
        role: 'treeitem',
        'aria-selected': String(state.selection === op.id),
        'aria-expanded': isBlock ? String(!collapsed) : null,
        title: op.note || null,
        dataset: { id: op.id },
      },
      h('span', { class: 'gutter', dataset: { action: 'breakpoint' }, title: hasBreakpoint ? 'Haltepunkt entfernen (F9)' : 'Haltepunkt setzen (F9)' },
        paused ? icon('play', 11) : h('span', { class: 'dot' })),
      Array.from({ length: depth }, () => h('span', { class: 'guide' })),
      h('span', { class: 'caret', dataset: isBlock ? { action: 'toggle' } : {} }, isBlock && icon(collapsed ? 'chevronright' : 'chevrondown', 14)),
      h('input', {
        type: 'checkbox',
        class: 'enable',
        checked: op.enabled !== false,
        title: op.enabled === false ? 'Deaktiviert – wird übersprungen' : 'Aktiv',
        'aria-label': 'Operation aktiv',
        dataset: { action: 'enable' },
        tabIndex: -1,
      }),
      h('span', { class: `badge cat-${def?.category || 'unknown'}` }, icon(def?.icon || 'help', 14)),
      h('span', { class: 'title' }, opTitle(def, op)),
      summary && h('span', { class: 'summary' }, summary),
      isBlock && collapsed && op.children.length > 0 && h('span', { class: 'pill' }, op.children.length),
      h('span', { class: 'spacer' }),
      worst && h('span', { class: `problem ${worst}`, title: problems.map((p) => p.message).join('\n') }, icon('alert', 14)),
      op.onError === 'continue' && h('span', { class: 'flag', title: 'Fehler dieser Operation werden ignoriert' }, icon('shield', 13)),
      status?.durationMs != null && status.status !== 'skipped' && h('span', { class: 'duration' }, formatDuration(status.durationMs)),
      status &&
        h('span', { class: `state state-${status.status}`, title: STATUS_TEXT[status.status] },
          status.status === 'running' ? h('span', { class: 'spinner' }) : icon(STATUS_ICON[status.status] || 'minuscircle', 15)),
    );
  }

  function renderEmpty() {
    return h(
      'div',
      { class: 'tree-empty' },
      h('div', { class: 'tree-empty-icon' }, icon('layers', 30)),
      h('h3', null, 'Noch keine Operationen'),
      h('p', null, 'Ziehe Operationen aus der Liste links hierher oder füge sie per Doppelklick ein.'),
      h(
        'div',
        { class: 'tree-empty-actions' },
        button({ icon: 'play', label: 'Rundgang laden', kind: 'primary', onClick: () => actions.loadTemplate('rundgang.buildwerk.json') }),
        button({ icon: 'fileplus', label: 'Vorlage wählen …', onClick: () => actions.chooseTemplate() }),
      ),
    );
  }

  function render() {
    const rows = visibleEntries();
    clear(list);
    list.classList.toggle('is-empty', rows.length === 0);
    if (rows.length === 0) list.append(renderEmpty());
    else for (const row of rows) list.append(renderRow(row));
  }
  const scheduleRender = throttleFrame(render);

  function reveal() {
    list.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  on('macro', render);
  on('selection', ({ reveal: shouldReveal }) => {
    render();
    if (shouldReveal) reveal();
  });
  on('run', scheduleRender);

  // ----------------------------------------------------------------- mouse

  const rowOf = (event) => event.target.closest?.('.row');

  list.addEventListener('click', (event) => {
    const row = rowOf(event);
    if (!row) return;
    const id = row.dataset.id;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'breakpoint') return toggleBreakpoint(id);
    if (action === 'toggle') return toggleCollapsed(id);
    if (action === 'enable') return toggleEnabled(id);
    select(id);
  });

  list.addEventListener('dblclick', (event) => {
    const row = rowOf(event);
    if (!row || event.target.closest('[data-action]')) return;
    const entry = findOp(state.macro, row.dataset.id);
    if (entry?.op.children) toggleCollapsed(entry.op.id);
  });

  list.addEventListener('contextmenu', (event) => {
    const row = rowOf(event);
    event.preventDefault();
    if (row) select(row.dataset.id);
    const entry = row && selectedEntry();
    const running = isRunning();
    if (!entry) {
      return showMenu(event.clientX, event.clientY, [
        { label: 'Einfügen', icon: 'clipboard', hint: 'Strg+V', disabled: !state.clipboard, onSelect: pasteOp },
      ]);
    }
    const { op } = entry;
    showMenu(event.clientX, event.clientY, [
      { label: 'Ab hier ausführen', icon: 'play', disabled: running || op.enabled === false, onSelect: () => actions.run({ startAt: op.id }) },
      { label: 'Nur diese Operation ausführen', icon: 'target', disabled: running, onSelect: () => actions.run({ only: op.id }) },
      { label: state.breakpoints.has(op.id) ? 'Haltepunkt entfernen' : 'Haltepunkt setzen', icon: 'dot', hint: 'F9', onSelect: () => toggleBreakpoint(op.id) },
      { separator: true },
      { label: op.enabled === false ? 'Aktivieren' : 'Deaktivieren', icon: 'check', hint: 'Leertaste', onSelect: () => toggleEnabled(op.id) },
      { label: 'In Gruppe einschliessen', icon: 'layers', onSelect: () => wrapInGroup(op.id) },
      { label: 'Duplizieren', icon: 'copy', hint: 'Strg+D', onSelect: () => duplicateOp(op.id) },
      { separator: true },
      { label: 'Ausschneiden', icon: 'scissors', hint: 'Strg+X', onSelect: () => cutOp(op.id) },
      { label: 'Kopieren', icon: 'copy', hint: 'Strg+C', onSelect: () => copyOp(op.id) },
      { label: 'Einfügen', icon: 'clipboard', hint: 'Strg+V', disabled: !state.clipboard, onSelect: pasteOp },
      { separator: true },
      { label: 'Löschen', icon: 'trash', hint: 'Entf', danger: true, onSelect: () => removeOp(op.id) },
    ]);
  });

  // ----------------------------------------------------------- drag & drop

  function setDropTarget(target) {
    list.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    list.classList.remove('drop-end');
    dropTarget = target;
    if (!target) return;
    if (!target.id) list.classList.add('drop-end');
    else list.querySelector(`.row[data-id="${target.id}"]`)?.classList.add(`drop-${target.position}`);
  }

  /** Works out where a drop on `row` would land, or null when it is not allowed. */
  function targetFor(row, event, draggedId) {
    const entry = findOp(state.macro, row.dataset.id);
    if (!entry) return null;
    const { op } = entry;
    if (draggedId && (draggedId === op.id || contains(findOp(state.macro, draggedId)?.op || {}, op.id))) return null;
    const rect = row.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    if (!op.children) return { id: op.id, position: ratio < 0.5 ? 'before' : 'after' };
    if (ratio < 0.3) return { id: op.id, position: 'before' };
    const showsChildren = !state.collapsed.has(op.id) && op.children.length > 0;
    if (ratio > 0.7 && !showsChildren) return { id: op.id, position: 'after' };
    return { id: op.id, position: 'inside' };
  }

  let draggedId = null;
  list.addEventListener('dragstart', (event) => {
    const row = rowOf(event);
    if (!row) return;
    draggedId = row.dataset.id;
    event.dataTransfer.setData('application/x-bw-op', draggedId);
    event.dataTransfer.effectAllowed = 'copyMove';
    row.classList.add('dragging');
  });
  list.addEventListener('dragend', () => {
    draggedId = null;
    setDropTarget(null);
    list.querySelector('.dragging')?.classList.remove('dragging');
  });
  list.addEventListener('dragover', (event) => {
    const types = event.dataTransfer.types;
    const fromPalette = types.includes('application/x-bw-type');
    if (!fromPalette && !types.includes('application/x-bw-op')) return;
    const row = rowOf(event);
    const target = row ? targetFor(row, event, fromPalette ? null : draggedId) : { id: null, position: 'end' };
    setDropTarget(target);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = fromPalette || event.ctrlKey ? 'copy' : 'move';
  });
  list.addEventListener('dragleave', (event) => {
    if (!list.contains(event.relatedTarget)) setDropTarget(null);
  });
  list.addEventListener('drop', (event) => {
    const target = dropTarget;
    setDropTarget(null);
    if (!target) return;
    event.preventDefault();
    const type = event.dataTransfer.getData('application/x-bw-type');
    const id = event.dataTransfer.getData('application/x-bw-op');
    if (type) addOp(type, target);
    else if (id && event.ctrlKey) insertOp(cloneOp(findOp(state.macro, id).op), target);
    else if (id) moveOp(id, target);
    list.focus();
  });

  // -------------------------------------------------------------- keyboard

  list.addEventListener('keydown', (event) => {
    const rows = visibleEntries();
    const index = rows.findIndex((row) => row.op.id === state.selection);
    const current = rows[index];
    const mod = event.ctrlKey || event.metaKey;
    const go = (row) => row && select(row.op.id, { reveal: true });
    const handled = () => event.preventDefault();

    if (event.altKey && current) {
      if (event.key === 'ArrowUp') return handled(), shiftOp(-1);
      if (event.key === 'ArrowDown') return handled(), shiftOp(1);
      if (event.key === 'ArrowLeft') return handled(), outdentOp();
      if (event.key === 'ArrowRight') return handled(), indentOp();
      return;
    }
    if (mod) {
      const key = event.key.toLowerCase();
      if (key === 'd' && current) return handled(), duplicateOp();
      if (key === 'c' && current) return handled(), copyOp();
      if (key === 'x' && current) return handled(), cutOp();
      if (key === 'v') return handled(), pasteOp();
      return;
    }
    switch (event.key) {
      case 'ArrowDown': handled(); go(rows[index + 1] || rows[index] || rows[0]); break;
      case 'ArrowUp': handled(); go(rows[index - 1] || rows[0]); break;
      case 'Home': handled(); go(rows[0]); break;
      case 'End': handled(); go(rows[rows.length - 1]); break;
      case 'ArrowLeft':
        if (!current) break;
        handled();
        if (current.op.children && !state.collapsed.has(current.op.id)) toggleCollapsed(current.op.id, true);
        else if (current.parent) go({ op: current.parent });
        break;
      case 'ArrowRight':
        if (!current?.op.children) break;
        handled();
        if (state.collapsed.has(current.op.id)) toggleCollapsed(current.op.id, false);
        else go(rows[index + 1]?.parent === current.op ? rows[index + 1] : null);
        break;
      case 'Delete':
      case 'Backspace':
        if (current) handled(), removeOp();
        break;
      case ' ':
        if (current) handled(), toggleEnabled();
        break;
      case 'Enter':
        if (current) handled(), document.querySelector('#props input, #props textarea, #props select')?.focus();
        break;
      default:
        break;
    }
  });

  render();
  return { focus: () => list.focus() };
}
