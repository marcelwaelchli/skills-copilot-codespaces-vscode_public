// Left panel: the catalog of operations, searchable, grouped by category.

import { clear, h, storageGet, storageSet } from './dom.js';
import { icon } from './icons.js';
import { addOp, setView, state } from './store.js';

export function mountPalette(root) {
  const closed = new Set(JSON.parse(storageGet('bw:palette-closed', '[]')));
  const search = h('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Operation suchen …',
    'aria-label': 'Operation suchen',
    oninput: () => render(),
  });
  const list = h('div', { class: 'palette-list' });
  root.append(h('div', { class: 'panel-head' }, h('h2', null, 'Operationen')), h('div', { class: 'palette-search' }, search), list);

  function add(type) {
    setView('ops');
    addOp(type);
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    clear(list);
    for (const category of state.info.categories) {
      const defs = state.info.operations.filter(
        (def) =>
          def.category === category.id &&
          (!query || def.label.toLowerCase().includes(query) || def.description.toLowerCase().includes(query) || def.type.includes(query)),
      );
      if (defs.length === 0) continue;
      const isClosed = !query && closed.has(category.id);
      const head = h(
        'button',
        {
          type: 'button',
          class: 'palette-category',
          'aria-expanded': String(!isClosed),
          onclick: () => {
            if (closed.has(category.id)) closed.delete(category.id);
            else closed.add(category.id);
            storageSet('bw:palette-closed', JSON.stringify([...closed]));
            render();
          },
        },
        icon(isClosed ? 'chevronright' : 'chevrondown', 14),
        h('span', null, category.label),
        h('span', { class: 'count' }, defs.length),
      );
      list.append(head);
      if (isClosed) continue;
      for (const def of defs) {
        list.append(
          h(
            'div',
            {
              class: 'palette-item',
              draggable: true,
              tabIndex: 0,
              title: `${def.description}\n\nDoppelklick oder Ziehen fügt die Operation ein.`,
              dataset: { type: def.type },
              ondragstart: (event) => {
                event.dataTransfer.setData('application/x-bw-type', def.type);
                event.dataTransfer.effectAllowed = 'copy';
              },
              ondblclick: () => add(def.type),
              onkeydown: (event) => {
                if (event.key === 'Enter') add(def.type);
              },
            },
            h('span', { class: `badge cat-${def.category}` }, icon(def.icon, 14)),
            h('span', { class: 'palette-label' }, def.label),
          ),
        );
      }
    }
    if (!list.children.length) list.append(h('p', { class: 'empty-note' }, 'Keine passende Operation gefunden.'));
  }

  render();
}
