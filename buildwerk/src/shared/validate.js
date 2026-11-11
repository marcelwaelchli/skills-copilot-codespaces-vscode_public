// Static checks on a macro. Runs in the browser (live problem list) and on the
// Node side (before a run starts).

import { CHAIN_RULES, VAR_NAME, effectiveProps, isFieldVisible, parseChoices, referencedVars, walk } from './model.js';

const LOOP_TYPES = new Set(['flow.foreach', 'flow.while']);

/**
 * @param {object} macro
 * @param {Map<string, object>} catalog operation definitions keyed by type
 * @param {string[]} systemVariables names that exist at run time without being declared
 * @returns {{opId: string|null, level: 'error'|'warning', message: string}[]}
 */
export function validateMacro(macro, catalog, systemVariables = []) {
  const problems = [];
  const add = (opId, level, message) => problems.push({ opId, level, message });

  const known = new Set(systemVariables);
  const seen = new Set();
  for (const variable of macro.variables || []) {
    const name = variable.name || '';
    if (!VAR_NAME.test(name)) {
      add(null, 'error', `Variablenname «${name}» ist ungültig (erlaubt: Buchstaben, Ziffern, Unterstrich).`);
    } else if (seen.has(name)) {
      add(null, 'error', `Variable «${name}» ist mehrfach definiert.`);
    } else if (systemVariables.includes(name)) {
      add(null, 'error', `«${name}» ist eine Systemvariable und kann nicht neu definiert werden.`);
    }
    seen.add(name);
    known.add(name);
    // A default that refers to other variables can only be checked at run time.
    const choices = parseChoices(variable.choices);
    const fallback = String(variable.value ?? '');
    if (choices.length && !fallback.includes('${') && !choices.includes(fallback)) {
      add(null, 'error', `Der Standardwert von «${name}» muss einer der Auswahlwerte sein (${choices.join(', ')}).`);
    }
  }

  // Variables that operations create at run time (loop variables, captured output, ...).
  for (const { op } of walk(macro.operations || [])) {
    const def = catalog.get(op.type);
    if (!def) continue;
    const props = effectiveProps(def, op);
    for (const field of def.fields) {
      if (field.type === 'variable' && props[field.key]) known.add(String(props[field.key]));
    }
    for (const template of def.provides || []) {
      known.add(template.replace(/\{(\w+)\}/g, (_, key) => props[key] ?? ''));
    }
  }

  const parents = new Map();
  for (const { op, parent, list, index } of walk(macro.operations || [])) {
    parents.set(op.id, parent);
    const def = catalog.get(op.type);
    if (!def) {
      add(op.id, 'error', `Unbekannter Operationstyp «${op.type}».`);
      continue;
    }
    if (op.enabled === false) continue;

    const allowedBefore = CHAIN_RULES[op.type];
    if (allowedBefore) {
      const previous = list[index - 1];
      if (!previous || !allowedBefore.includes(previous.type)) {
        const names = allowedBefore.map((type) => `«${catalog.get(type)?.label ?? type}»`).join(' oder ');
        add(op.id, 'error', `«${def.label}» muss direkt auf ${names} folgen.`);
      }
    }

    if (op.type === 'flow.break' || op.type === 'flow.continue') {
      let ancestor = parent;
      while (ancestor && !LOOP_TYPES.has(ancestor.type)) ancestor = parents.get(ancestor.id);
      if (!ancestor) add(op.id, 'error', `«${def.label}» ist nur innerhalb einer Schleife erlaubt.`);
    }

    const props = effectiveProps(def, op);
    for (const field of def.fields) {
      if (!isFieldVisible(field, props)) continue;
      const value = props[field.key];
      const empty = value === undefined || value === null || String(value).trim() === '';
      if (field.required && empty) {
        add(op.id, 'error', `Feld «${field.label}» darf nicht leer sein.`);
        continue;
      }
      if (empty || typeof value !== 'string') continue;
      if (field.type === 'variable' && !VAR_NAME.test(value)) {
        add(op.id, 'error', `«${value}» ist kein gültiger Variablenname.`);
      }
      // Shell scripts legitimately contain ${...} that the shell itself expands.
      if (field.raw || field.passthrough) continue;
      for (const name of referencedVars(value)) {
        if (!known.has(name)) {
          add(op.id, 'warning', `Variable «${name}» ist nirgends definiert. Wird sie nicht zur Laufzeit gesetzt, schlägt diese Operation fehl.`);
        }
      }
    }
  }
  return problems;
}
