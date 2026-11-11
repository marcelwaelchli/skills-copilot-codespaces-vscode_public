// Tiny DOM helpers – the UI is plain DOM without a framework.

import { icon } from './icons.js';

/**
 * Creates an element. Attributes starting with `on` become event listeners,
 * `class` and `dataset` are handled, everything else is set as a property
 * when the element has one and as an attribute otherwise. False and null are
 * skipped; use `attrs` for attributes that need a literal value like "false".
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'attrs') for (const [name, text] of Object.entries(value)) el.setAttribute(name, text);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Attributes for inputs that hold code-like text. */
export const PLAIN_TEXT = { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' };

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** A toolbar-style button with an icon and an optional text label. */
export function button({ icon: iconName, label, title, onClick, kind = '', disabled = false, id }) {
  return h(
    'button',
    // The visible label is the accessible name; only icon-only buttons need one spelled out.
    { type: 'button', class: `btn ${kind}`.trim(), title: title || label, 'aria-label': label ? null : title, onclick: onClick, disabled, id },
    iconName && icon(iconName, 16),
    label && h('span', null, label),
  );
}

/** Calls `fn` at most once per animation frame. */
export function throttleFrame(fn) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

export function storageGet(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the setting simply does not persist
  }
}
