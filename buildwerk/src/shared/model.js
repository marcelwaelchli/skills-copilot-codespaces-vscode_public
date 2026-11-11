// Macro document model. Shared between the Node side and the browser, so this
// file must not touch any platform API.

export const FORMAT = 'buildwerk/1';
export const MACRO_EXTENSION = '.buildwerk.json';

/** Matches `${NAME}`, `${env:NAME}` and the escaped form `$${NAME}`. */
export const VAR_REF = /\$(\$)?\{((?:env:)?[A-Za-z_][A-Za-z0-9_]*)\}/g;
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Operation types that only make sense directly after a specific sibling. */
export const CHAIN_RULES = {
  'flow.elseif': ['flow.if', 'flow.elseif'],
  'flow.else': ['flow.if', 'flow.elseif'],
  'flow.catch': ['flow.try'],
  'flow.finally': ['flow.try', 'flow.catch'],
};

export function newId() {
  return 'op_' + Math.random().toString(36).slice(2, 10);
}

export function createMacro(name = 'Neues Makro') {
  return { format: FORMAT, name, description: '', baseDir: '.', variables: [], operations: [] };
}

export function createOp(def) {
  const props = {};
  for (const field of def.fields || []) {
    if (field.default !== undefined) props[field.key] = field.default;
  }
  const op = { id: newId(), type: def.type, enabled: true, props };
  if (def.container) op.children = [];
  return op;
}

/** Pre-order traversal over every operation in a list. */
export function* walk(ops, parent = null, depth = 0) {
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    yield { op, parent, list: ops, index, depth };
    if (op.children) yield* walk(op.children, op, depth + 1);
  }
}

export function findOp(macro, id) {
  for (const entry of walk(macro.operations)) if (entry.op.id === id) return entry;
  return null;
}

/** True when `id` is a descendant of `op` (not `op` itself). */
export function contains(op, id) {
  if (!op.children) return false;
  for (const entry of walk(op.children)) if (entry.op.id === id) return true;
  return false;
}

/** Deep copy with fresh ids, used for duplicate / paste / templates. */
export function cloneOp(op) {
  const copy = JSON.parse(JSON.stringify(op));
  for (const entry of walk([copy])) entry.op.id = newId();
  return copy;
}

/** Evaluates a `{ key, equals | in | notIn }` rule against property values. */
export function matchRule(rule, props) {
  const value = props[rule.key];
  if ('equals' in rule) return value === rule.equals;
  if (rule.in) return rule.in.includes(value);
  if (rule.notIn) return !rule.notIn.includes(value);
  return Boolean(value);
}

export function isFieldVisible(field, props) {
  return !field.showIf || matchRule(field.showIf, props);
}

/** Property values with field defaults filled in. */
export function effectiveProps(def, op) {
  const props = { ...(op.props || {}) };
  for (const field of def?.fields || []) {
    if (props[field.key] === undefined && field.default !== undefined) props[field.key] = field.default;
  }
  return props;
}

/** One-line description of what an operation does, built from `def.summary`. */
export function summarize(def, op) {
  if (!def?.summary) return '';
  const props = effectiveProps(def, op);
  // Either one template, or a list of { if: rule, text } where the first match wins.
  const template = Array.isArray(def.summary)
    ? def.summary.find((variant) => !variant.if || matchRule(variant.if, props))?.text
    : def.summary;
  if (!template) return '';
  const text = template
    .replace(/\{(\w+)\}/g, (_, key) => {
      const field = def.fields.find((f) => f.key === key);
      if (!field || !isFieldVisible(field, props)) return '';
      const value = props[key];
      if (value === undefined || value === null || value === '') return '';
      if (field.type === 'checkbox') return value ? field.label : '';
      if (field.type === 'select') {
        const option = field.options.find((o) => o.value === value);
        return option?.short ?? String(value);
      }
      const lines = String(value).split('\n').filter((line) => line.trim());
      return lines.length > 1 ? `${lines[0]} …` : lines[0] || '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 100 ? text.slice(0, 99) + '…' : text;
}

export function opTitle(def, op) {
  return op.name?.trim() || def?.label || op.type;
}

/** Title plus summary, as shown in logs. */
export function opLabel(def, op) {
  const title = opTitle(def, op);
  if (op.name?.trim()) return title;
  const summary = summarize(def, op);
  return summary ? `${title}: ${summary}` : title;
}

/**
 * Replaces `${NAME}` references. Unknown names stay as they are, unless
 * `onMissing` is given: it may throw or return a replacement.
 */
export function substitute(text, lookup, onMissing) {
  return String(text).replace(VAR_REF, (match, escaped, name) => {
    if (escaped) return match.slice(1);
    const value = lookup(name);
    if (value !== undefined) return value;
    return onMissing ? onMissing(name) : match;
  });
}

/** Names referenced via `${NAME}` in a string (escaped and env: references excluded). */
export function referencedVars(text) {
  const names = [];
  for (const match of String(text).matchAll(VAR_REF)) {
    if (!match[1] && !match[2].startsWith('env:')) names.push(match[2]);
  }
  return names;
}

/** Allowed values of a variable or question: separated by comma or line break; empty means «anything». */
export function parseChoices(text) {
  return String(text ?? '').split(/[,\n]/).map((choice) => choice.trim()).filter(Boolean);
}

export function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
}
