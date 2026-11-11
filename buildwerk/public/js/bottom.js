// Bottom panel: run log, run-time variables, problems and run history.

import { findOp, formatDuration, opTitle } from '/shared/model.js';
import { api } from './api.js';
import { append, button, clear, h, throttleFrame } from './dom.js';
import { icon } from './icons.js';
import { toast } from './menu.js';
import { onRunEvent } from './runner.js';
import { defOf, isRunning, on, select, setBottomTab, setView, state } from './store.js';

const MAX_LINES = 30000;
const STATUS_ICON = { success: 'checkcircle', failed: 'xcircle', warning: 'alert', cancelled: 'stop' };
const RUN_RESULT = {
  success: ['checkcircle', 'Erfolgreich'],
  failed: ['xcircle', 'Fehlgeschlagen'],
  cancelled: ['stop', 'Abgebrochen'],
};

const clock = (t) => new Date(t).toLocaleTimeString('de-CH');

/** Hierarchical log: one collapsible section per executed operation. */
function createLogView(container) {
  let sections = new Map();
  let lines = 0;
  let pending = [];

  const hint = () => h('p', { class: 'empty-note' }, 'Noch kein Lauf. Starte das Makro mit F5 – die Ausgabe erscheint hier.');
  container.append(hint());

  function line(parent, stream, text, t) {
    for (const part of String(text).split('\n')) {
      parent.append(h('div', { class: `log-line s-${stream}`, title: t ? clock(t) : null }, part || ' '));
      lines++;
    }
    while (lines > MAX_LINES) {
      const oldest = container.querySelector('.log-line');
      if (!oldest) break;
      oldest.remove();
      lines--;
    }
  }

  function apply(event) {
    switch (event.type) {
      case 'run-start':
        clear(container);
        sections = new Map();
        lines = 0;
        container.append(h('div', { class: 'log-run' }, icon('play', 12), h('strong', null, event.macro || 'Makro'), h('span', { class: 'muted' }, `gestartet um ${clock(event.t)}`)));
        break;
      case 'op-start': {
        const parent = sections.get(event.parentExecId);
        const body = h('div', { class: 'log-body' });
        const el = h(
          'div',
          { class: 'log-section running empty', dataset: { op: event.opId } },
          h(
            'div',
            { class: 'log-head' },
            h('span', { class: 'caret' }, icon('chevrondown', 12)),
            h('span', { class: 'state' }, h('span', { class: 'spinner' })),
            h('span', { class: 'log-label', title: 'Operation im Baum anzeigen' }, event.label),
            h('span', { class: 'log-duration' }),
          ),
          body,
        );
        (parent?.body || container).append(el);
        parent?.el.classList.remove('empty');
        sections.set(event.execId, { el, body });
        break;
      }
      case 'output': {
        const section = sections.get(event.execId);
        section?.el.classList.remove('empty');
        line(section?.body || container, event.stream, event.text, event.t);
        break;
      }
      case 'op-end': {
        const section = sections.get(event.execId);
        if (!section) break;
        section.el.classList.remove('running');
        section.el.classList.add(event.status);
        section.el.querySelector('.state').replaceChildren(icon(STATUS_ICON[event.status] || 'checkcircle', 13));
        section.el.querySelector('.log-duration').textContent = formatDuration(event.durationMs);
        if (event.error) {
          section.el.classList.remove('empty');
          line(section.body, 'error', event.error, event.t);
        }
        break;
      }
      case 'paused':
        break;
      case 'run-end': {
        const [iconName, text] = RUN_RESULT[event.status] || RUN_RESULT.failed;
        container.append(h('div', { class: `log-run result ${event.status}` }, icon(iconName, 14), h('strong', null, text), h('span', { class: 'muted' }, `nach ${formatDuration(event.durationMs)}`)));
        break;
      }
      default:
        break;
    }
  }

  // Events arrive in bursts; apply them once per frame and keep the view pinned to the end.
  const flush = throttleFrame(() => {
    const pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    for (const event of pending) apply(event);
    pending = [];
    if (pinned) container.scrollTop = container.scrollHeight;
  });

  container.addEventListener('click', (event) => {
    const head = event.target.closest('.log-head');
    if (!head) return;
    const section = head.parentElement;
    if (event.target.closest('.log-label')) {
      const id = section.dataset.op;
      if (findOp(state.macro, id)) {
        setView('ops');
        select(id, { reveal: true });
      }
      return;
    }
    if (!section.classList.contains('empty')) section.classList.toggle('collapsed');
  });

  return {
    handle(event) {
      pending.push(event);
      flush();
    },
    replay(events) {
      pending = [];
      for (const event of events) apply(event);
      container.scrollTop = 0;
    },
    setCollapsed(collapsed) {
      container.querySelectorAll('.log-section:not(.empty)').forEach((el) => el.classList.toggle('collapsed', collapsed));
    },
    clear() {
      pending = [];
      clear(container).append(hint());
      sections = new Map();
      lines = 0;
    },
    text: () => [...container.querySelectorAll('.log-run, .log-label, .log-line')].map((el) => el.textContent).join('\n'),
  };
}

export function mountBottom(root) {
  const panes = {
    log: h('div', { class: 'pane log', tabIndex: 0 }),
    vars: h('div', { class: 'pane' }),
    problems: h('div', { class: 'pane' }),
    history: h('div', { class: 'pane' }),
  };
  const logView = createLogView(panes.log);
  onRunEvent((event) => logView.handle(event));

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const tools = h('div', { class: 'tools' });
  append(root, [h('div', { class: 'panel-head' }, tabs, tools), Object.values(panes)]);

  const LABELS = { log: 'Protokoll', vars: 'Laufzeitvariablen', problems: 'Probleme', history: 'Verlauf' };

  function renderTabs() {
    const errors = state.problems.filter((p) => p.level === 'error').length;
    const warnings = state.problems.length - errors;
    clear(tabs);
    for (const [id, label] of Object.entries(LABELS)) {
      tabs.append(
        h(
          'button',
          { type: 'button', class: `tab ${state.bottomTab === id ? 'active' : ''}`, role: 'tab', 'aria-selected': String(state.bottomTab === id), onclick: () => setBottomTab(id) },
          label,
          id === 'problems' && state.problems.length > 0 && h('span', { class: `count ${errors ? 'error' : 'warning'}` }, errors || warnings),
        ),
      );
    }
    clear(tools);
    if (state.bottomTab === 'log') {
      tools.append(
        button({ icon: 'collapse', title: 'Alle Abschnitte einklappen', kind: 'ghost icon-only', onClick: () => logView.setCollapsed(true) }),
        button({ icon: 'expand', title: 'Alle Abschnitte ausklappen', kind: 'ghost icon-only', onClick: () => logView.setCollapsed(false) }),
        button({
          icon: 'copy',
          title: 'Protokoll als Text kopieren',
          kind: 'ghost icon-only',
          onClick: () => navigator.clipboard?.writeText(logView.text()).then(() => toast('Protokoll kopiert'), () => toast('Kopieren nicht möglich', 'error')),
        }),
        button({ icon: 'trash', title: 'Protokoll leeren', kind: 'ghost icon-only', onClick: () => logView.clear() }),
      );
    }
    for (const [id, pane] of Object.entries(panes)) pane.hidden = id !== state.bottomTab;
  }

  function renderVars() {
    const pane = clear(panes.vars);
    const entries = [...state.run.vars];
    if (!entries.length) return void pane.append(h('p', { class: 'empty-note' }, 'Während und nach einem Lauf stehen hier die aktuellen Werte aller Variablen.'));
    const rows = (system) => entries.filter(([, v]) => Boolean(v.system) === system).map(([name, v]) => h('tr', { class: system ? 'system' : '' }, h('td', { class: 'mono' }, name), h('td', { class: 'mono value' }, v.value)));
    pane.append(h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Variable'), h('th', null, 'Aktueller Wert'))), h('tbody', null, rows(false), rows(true))));
  }

  function renderProblems() {
    const pane = clear(panes.problems);
    if (!state.problems.length) return void pane.append(h('p', { class: 'empty-note' }, 'Keine Probleme gefunden.'));
    for (const problem of state.problems) {
      const entry = problem.opId && findOp(state.macro, problem.opId);
      pane.append(
        h(
          'button',
          {
            type: 'button',
            class: `problem-row ${problem.level}`,
            onclick: () => {
              if (entry) {
                setView('ops');
                select(entry.op.id, { reveal: true });
              } else {
                setView('vars');
              }
            },
          },
          icon('alert', 14),
          h('span', { class: 'where' }, entry ? opTitle(defOf(entry.op), entry.op) : 'Variablen'),
          h('span', null, problem.message),
        ),
      );
    }
  }

  async function renderHistory() {
    const pane = panes.history;
    let entries;
    try {
      entries = await api.get('/api/history');
    } catch (error) {
      return void clear(pane).append(h('p', { class: 'empty-note' }, error.message));
    }
    clear(pane);
    if (!entries.length) return void pane.append(h('p', { class: 'empty-note' }, 'Noch keine Läufe. Jeder Lauf wird hier mit seinem Protokoll abgelegt.'));
    for (const entry of entries) {
      const [iconName, text] = RUN_RESULT[entry.status] || RUN_RESULT.failed;
      pane.append(
        h(
          'button',
          {
            type: 'button',
            class: `history-row ${entry.status}`,
            title: 'Protokoll dieses Laufs anzeigen',
            onclick: async () => {
              if (isRunning()) return toast('Während eines Laufs kann kein altes Protokoll geöffnet werden.', 'error');
              try {
                logView.replay(await api.get(`/api/history/log?id=${encodeURIComponent(entry.id)}`));
                setBottomTab('log');
              } catch (error) {
                toast(error.message, 'error');
              }
            },
          },
          icon(iconName, 14),
          h('span', { class: 'name' }, entry.macro || 'Makro'),
          h('span', { class: 'muted' }, text),
          h('span', { class: 'muted' }, new Date(entry.startedAt).toLocaleString('de-CH')),
          h('span', { class: 'muted right' }, formatDuration(entry.durationMs)),
        ),
      );
    }
  }

  const scheduleVars = throttleFrame(() => state.bottomTab === 'vars' && renderVars());

  on('bottom', () => {
    renderTabs();
    if (state.bottomTab === 'vars') renderVars();
    if (state.bottomTab === 'problems') renderProblems();
    if (state.bottomTab === 'history') renderHistory();
  });
  on('macro', ({ source }) => {
    if (source === 'collapse' || source === 'breakpoint') return;
    renderTabs();
    if (state.bottomTab === 'problems') renderProblems();
  });
  on('run', ({ event }) => {
    scheduleVars();
    if (event?.type === 'run-end' && state.bottomTab === 'history') setTimeout(renderHistory, 300);
  });

  renderTabs();
  return logView;
}
