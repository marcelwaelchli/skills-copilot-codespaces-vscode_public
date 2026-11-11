// Pop-up menus (context menu, variable picker) and modal dialogs.

import { append, clear, h } from './dom.js';
import { icon } from './icons.js';

let openMenu = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/**
 * Shows a menu at a screen position.
 * @param {{label?: string, icon?: string, hint?: string, danger?: boolean, disabled?: boolean, separator?: boolean, onSelect?: () => void}[]} items
 */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.separator) {
      menu.append(h('div', { class: 'menu-separator' }));
      continue;
    }
    menu.append(
      h(
        'button',
        {
          type: 'button',
          class: `menu-item${item.danger ? ' danger' : ''}`,
          role: 'menuitem',
          disabled: item.disabled,
          onclick: () => {
            closeMenu();
            item.onSelect?.();
          },
        },
        h('span', { class: 'menu-icon' }, item.icon && icon(item.icon, 15)),
        h('span', { class: 'menu-label' }, item.label),
        item.hint && h('span', { class: 'menu-hint' }, item.hint),
      ),
    );
  }
  document.body.append(menu);
  // Keep the menu inside the window.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  openMenu = menu;
  menu.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.contains(event.target)) closeMenu();
}, true);
document.addEventListener('keydown', (event) => {
  if (!openMenu) return;
  if (event.key === 'Escape') {
    closeMenu();
    event.stopPropagation();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = [...openMenu.querySelectorAll('.menu-item:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    event.preventDefault();
  }
}, true);
window.addEventListener('blur', closeMenu);

/**
 * Opens a modal dialog and resolves with the value of the button that closed
 * it (or null for Escape / the close button).
 * @param {object} options
 * @param {string} options.title
 * @param {Node|Node[]} options.body
 * @param {{label: string, value?: any, primary?: boolean, danger?: boolean, keepOpen?: boolean, onClick?: (dialog: HTMLDialogElement) => any}[]} [options.buttons]
 * @param {string} [options.width]
 */
export function openDialog({ title, body, buttons = [], width }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dialog' });
    if (width) dialog.style.width = width;
    let result = null;
    const close = (value) => {
      result = value;
      dialog.close();
    };
    const footer = h(
      'footer',
      { class: 'dialog-foot' },
      buttons.map((spec) =>
        h(
          'button',
          {
            type: 'button',
            class: `btn ${spec.primary ? 'primary' : ''} ${spec.danger ? 'danger' : ''}`,
            dataset: spec.primary ? { default: 'true' } : {},
            onclick: async () => {
              const value = spec.onClick ? await spec.onClick(dialog) : spec.value;
              if (!spec.keepOpen && value !== false) close(value ?? spec.value ?? true);
            },
          },
          spec.label,
        ),
      ),
    );
    append(dialog, [
      h('header', { class: 'dialog-head' }, h('h2', null, title), h('button', { type: 'button', class: 'btn ghost icon-only', title: 'Schliessen', onclick: () => close(null) }, icon('x', 16))),
      h('div', { class: 'dialog-body' }, body),
      buttons.length > 0 && footer,
    ]);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    dialog.addEventListener('keydown', (event) => {
      // Enter triggers the primary button unless the focus is in a multi-line field.
      if (event.key === 'Enter' && !event.shiftKey && event.target.tagName !== 'TEXTAREA' && event.target.tagName !== 'BUTTON') {
        const primary = dialog.querySelector('[data-default]');
        if (primary) {
          event.preventDefault();
          primary.click();
        }
      }
    });
    dialog.close_ = close;
    document.body.append(dialog);
    dialog.showModal();
    // Start in the first field; without one, on the default button or the first choice –
    // never on the close button, where Enter would dismiss the dialog.
    const first =
      dialog.querySelector('.dialog-body input:not([readonly]), .dialog-body textarea:not([readonly]), .dialog-body select') ||
      dialog.querySelector('[data-default]') ||
      dialog.querySelector('.dialog-body button, .dialog-foot button');
    first?.focus();
    if (first?.tagName === 'INPUT' && first.type === 'text') first.select();
  });
}

export function confirmDialog({ title, message, okLabel = 'OK', cancelLabel = 'Abbrechen', danger = false }) {
  return openDialog({
    title,
    body: h('p', { class: 'dialog-text' }, message),
    buttons: [
      { label: cancelLabel, value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
    width: '420px',
  }).then((value) => value === true);
}

let toastTimer = null;

/** Brief, unobtrusive feedback at the bottom of the window. */
export function toast(message, kind = 'info') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status' });
    document.body.append(el);
  }
  clear(el).append(icon(kind === 'error' ? 'xcircle' : 'checkcircle', 16), h('span', null, message));
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 2500);
}
