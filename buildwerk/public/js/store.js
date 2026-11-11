// Application state and every way to change it. Views subscribe to topics
// and re-render; they never modify the macro directly.

import { cloneOp, contains, createMacro, createOp, findOp, newId, walk } from '/shared/model.js';
import { validateMacro } from '/shared/validate.js';

export const state = {
  info: null,
  /** @type {Map<string, object>} operation definitions by type */
  catalog: new Map(),
  macro: createMacro(),
  /** Path of the macro inside the workspace, or null while unsaved. */
  path: null,
  savedSnapshot: '',
  selection: null,
  collapsed: new Set(),
  view: 'ops',
  bottomTab: 'log',
  breakpoints: new Set(),
  problems: [],
  /** @type {Map<string, {level: string, message: string}[]>} */
  problemsByOp: new Map(),
  clipboard: null,
  run: {
    id: null,
    phase: 'idle', // idle | running | paused | done
    status: null,
    opStatus: new Map(),
    pausedOp: null,
    currentLabel: '',
    vars: new Map(),
    durationMs: 0,
  },
};

const listeners = new Map();

/** Topics: macro, selection, doc, run, view, bottom. */
export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
}

export function emit(topic, detail = {}) {
  for (const fn of listeners.get(topic) || []) fn(detail);
}

export const systemNames = () => (state.info?.systemVariables || []).map((v) => v.name);
export const defOf = (op) => state.catalog.get(op.type);
export const isDirty = () => JSON.stringify(state.macro) !== state.savedSnapshot;
export const isRunning = () => state.run.phase === 'running' || state.run.phase === 'paused';

// ------------------------------------------------------------------ history

const undoStack = [];
const redoStack = [];
let lastCoalesce = null;

const snapshot = () => JSON.stringify({ macro: state.macro, selection: state.selection });

function revalidate() {
  state.problems = validateMacro(state.macro, state.catalog, systemNames());
  state.problemsByOp = new Map();
  for (const problem of state.problems) {
    if (!problem.opId) continue;
    if (!state.problemsByOp.has(problem.opId)) state.problemsByOp.set(problem.opId, []);
    state.problemsByOp.get(problem.opId).push(problem);
  }
}

/**
 * Applies a change to the macro and records an undo step.
 * @param {(macro: object) => void} fn
 * @param {object} [options]
 * @param {string} [options.coalesce] consecutive changes with the same key (typing) share one undo step
 * @param {string} [options.source] which view made the change, so it can skip rebuilding itself
 */
export function mutate(fn, { coalesce, source } = {}) {
  const now = Date.now();
  const continues = coalesce && lastCoalesce?.key === coalesce && now - lastCoalesce.time < 1500;
  if (!continues) {
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  lastCoalesce = coalesce ? { key: coalesce, time: now } : null;
  fn(state.macro);
  revalidate();
  emit('macro', { source });
  emit('doc');
}

function restore(serialized) {
  const { macro, selection } = JSON.parse(serialized);
  state.macro = macro;
  state.selection = selection && findOp(macro, selection) ? selection : null;
  lastCoalesce = null;
  revalidate();
  emit('macro', { source: 'history' });
  emit('selection');
  emit('doc');
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

/** Replaces the whole document (new, open, template). */
export function setDocument(macro, path, { saved = true } = {}) {
  macro.variables ||= [];
  macro.operations ||= [];
  for (const { op } of walk(macro.operations)) {
    op.id ||= newId();
    op.props ||= {};
    if (state.catalog.get(op.type)?.container) op.children ||= [];
  }
  state.macro = macro;
  state.path = path;
  state.savedSnapshot = saved ? JSON.stringify(macro) : '';
  state.selection = null;
  state.collapsed = new Set();
  state.breakpoints = new Set();
  undoStack.length = 0;
  redoStack.length = 0;
  lastCoalesce = null;
  revalidate();
  emit('macro', { source: 'document' });
  emit('selection');
  emit('doc');
}

export function markSaved(path) {
  state.path = path;
  state.savedSnapshot = JSON.stringify(state.macro);
  emit('doc');
}

// ---------------------------------------------------------------- selection

export function select(id, { reveal = false } = {}) {
  if (id && reveal) {
    // Expand every ancestor so the row is visible.
    for (const entry of walk(state.macro.operations)) {
      if (contains(entry.op, id)) state.collapsed.delete(entry.op.id);
    }
  }
  if (state.selection === id && !reveal) return;
  state.selection = id;
  emit('selection', { reveal });
}

export const selectedEntry = () => (state.selection ? findOp(state.macro, state.selection) : null);

/** Operations in display order, skipping children of collapsed blocks. */
export function visibleEntries() {
  const rows = [];
  (function visit(ops, depth, parent) {
    ops.forEach((op, index) => {
      rows.push({ op, depth, parent, list: ops, index });
      if (op.children && !state.collapsed.has(op.id)) visit(op.children, depth + 1, op);
    });
  })(state.macro.operations, 0, null);
  return rows;
}

export function toggleCollapsed(id, force) {
  const collapse = force ?? !state.collapsed.has(id);
  if (collapse) state.collapsed.add(id);
  else state.collapsed.delete(id);
  emit('macro', { source: 'collapse' });
}

export function setAllCollapsed(collapse) {
  state.collapsed = new Set();
  if (collapse) for (const { op } of walk(state.macro.operations)) if (op.children) state.collapsed.add(op.id);
  emit('macro', { source: 'collapse' });
}

// ---------------------------------------------------------- tree operations

/** Where a new operation goes when it is added without an explicit drop target. */
function defaultTarget() {
  const entry = selectedEntry();
  if (!entry) return { id: null, position: 'end' };
  const { op } = entry;
  if (op.children && !state.collapsed.has(op.id)) return { id: op.id, position: 'inside' };
  return { id: op.id, position: 'after' };
}

function place(macro, op, target) {
  if (!target.id || target.position === 'end') {
    macro.operations.push(op);
    return;
  }
  const entry = findOp(macro, target.id);
  if (!entry) return void macro.operations.push(op);
  if (target.position === 'inside') {
    entry.op.children ||= [];
    entry.op.children.push(op);
    state.collapsed.delete(entry.op.id);
  } else {
    entry.list.splice(entry.index + (target.position === 'after' ? 1 : 0), 0, op);
  }
}

export function addOp(type, target = defaultTarget()) {
  const def = state.catalog.get(type);
  if (!def) return;
  const op = createOp(def);
  mutate((macro) => place(macro, op, target));
  select(op.id, { reveal: true });
  return op;
}

export function insertOp(op, target = defaultTarget()) {
  mutate((macro) => place(macro, op, target));
  select(op.id, { reveal: true });
}

export function moveOp(id, target) {
  if (id === target.id) return;
  const moving = findOp(state.macro, id);
  if (!moving || (target.id && contains(moving.op, target.id))) return; // not into itself
  mutate((macro) => {
    const entry = findOp(macro, id);
    entry.list.splice(entry.index, 1);
    place(macro, entry.op, target);
  });
  select(id, { reveal: true });
}

export function removeOp(id = state.selection) {
  const entry = id && findOp(state.macro, id);
  if (!entry) return;
  const next = entry.list[entry.index + 1] || entry.list[entry.index - 1] || entry.parent;
  mutate((macro) => {
    const current = findOp(macro, id);
    current.list.splice(current.index, 1);
  });
  for (const { op } of walk([entry.op])) state.breakpoints.delete(op.id);
  select(next?.id || null);
}

export function duplicateOp(id = state.selection) {
  const entry = id && findOp(state.macro, id);
  if (!entry) return;
  const copy = cloneOp(entry.op);
  mutate((macro) => {
    const current = findOp(macro, id);
    current.list.splice(current.index + 1, 0, copy);
  });
  select(copy.id);
}

export function toggleEnabled(id = state.selection) {
  if (!id || !findOp(state.macro, id)) return;
  mutate((macro) => {
    const { op } = findOp(macro, id);
    op.enabled = op.enabled === false;
  });
}

/** Moves an operation among its siblings (delta -1 / +1). */
export function shiftOp(delta, id = state.selection) {
  const entry = id && findOp(state.macro, id);
  if (!entry) return;
  const to = entry.index + delta;
  if (to < 0 || to >= entry.list.length) return;
  mutate((macro) => {
    const current = findOp(macro, id);
    current.list.splice(current.index, 1);
    current.list.splice(to, 0, current.op);
  });
  emit('selection', { reveal: true });
}

/** Moves an operation into the block above it. */
export function indentOp(id = state.selection) {
  const entry = id && findOp(state.macro, id);
  const previous = entry && entry.list[entry.index - 1];
  if (!previous?.children) return;
  moveOp(id, { id: previous.id, position: 'inside' });
}

/** Moves an operation out of its block, placing it right after the block. */
export function outdentOp(id = state.selection) {
  const entry = id && findOp(state.macro, id);
  if (!entry?.parent) return;
  moveOp(id, { id: entry.parent.id, position: 'after' });
}

export function wrapInGroup(id = state.selection) {
  const entry = id && findOp(state.macro, id);
  const def = state.catalog.get('flow.group');
  if (!entry || !def) return;
  const groupOp = createOp(def);
  mutate((macro) => {
    const current = findOp(macro, id);
    groupOp.children = [current.op];
    current.list.splice(current.index, 1, groupOp);
  });
  select(groupOp.id);
}

export function copyOp(id = state.selection) {
  const entry = id && findOp(state.macro, id);
  if (!entry) return;
  state.clipboard = JSON.stringify(entry.op);
  // Also offer it to other tabs and editors; failing silently is fine here.
  navigator.clipboard?.writeText(state.clipboard).catch(() => {});
}

export function cutOp(id = state.selection) {
  copyOp(id);
  removeOp(id);
}

export function pasteOp() {
  if (!state.clipboard) return;
  try {
    insertOp(cloneOp(JSON.parse(state.clipboard)));
  } catch {
    // clipboard content was not an operation
  }
}

// --------------------------------------------------------------- properties

export function updateOp(id, change, options) {
  mutate((macro) => {
    const entry = findOp(macro, id);
    if (entry) change(entry.op);
  }, options);
}

export function toggleBreakpoint(id = state.selection) {
  if (!id) return;
  if (state.breakpoints.has(id)) state.breakpoints.delete(id);
  else state.breakpoints.add(id);
  emit('macro', { source: 'breakpoint' });
  emit('breakpoints');
}

export function setView(view) {
  state.view = view;
  emit('view');
}

export function setBottomTab(tab) {
  state.bottomTab = tab;
  emit('bottom');
}

export function init(info) {
  state.info = info;
  state.catalog = new Map(info.operations.map((def) => [def.type, def]));
  setDocument(createMacro(), null);
}
