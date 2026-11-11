// Starts runs on the server and applies the incoming event stream to the state.

import { api } from './api.js';
import { emit, isRunning, on, select, state } from './store.js';

const consumers = new Set();

/** Registers a consumer for raw run events (the log view). */
export function onRunEvent(fn) {
  consumers.add(fn);
}

function resetRun() {
  state.run = { id: null, phase: 'idle', status: null, opStatus: new Map(), pausedOp: null, currentLabel: '', vars: new Map(), durationMs: 0 };
  active.clear();
}

/** Operations that are executing right now, in start order (several during «Parallel»). */
const active = new Map();
const latestActive = () => [...active.values()].at(-1) || '';

function handle(event) {
  const run = state.run;
  switch (event.type) {
    case 'op-start':
      run.opStatus.set(event.opId, { status: 'running' });
      active.set(event.execId, event.label);
      run.currentLabel = latestActive();
      break;
    case 'op-end':
      run.opStatus.set(event.opId, { status: event.status, durationMs: event.durationMs });
      active.delete(event.execId);
      run.currentLabel = latestActive();
      break;
    case 'op-skip':
      run.opStatus.set(event.opId, { status: 'skipped' });
      break;
    case 'var':
      run.vars.set(event.name, { value: event.value, system: event.system });
      break;
    case 'paused':
      run.phase = 'paused';
      run.pausedOp = event.opId;
      select(event.opId, { reveal: true });
      break;
    case 'resumed':
      run.phase = 'running';
      run.pausedOp = null;
      break;
    case 'run-end':
      run.phase = 'done';
      run.status = event.status;
      run.durationMs = event.durationMs;
      run.pausedOp = null;
      run.currentLabel = '';
      // Anything still marked as running was interrupted.
      for (const [id, status] of run.opStatus) if (status.status === 'running') run.opStatus.set(id, { status: 'cancelled' });
      break;
    default:
      break;
  }
  for (const consumer of consumers) consumer(event);
  emit('run', { event });
}

/** Follows a run that exists on the server (just started, or still active after a page reload). */
export function attach(runId) {
  resetRun();
  state.run.id = runId;
  state.run.phase = 'running';
  emit('run');
  const source = api.events(runId);
  // After a reconnect the server replays the run from the start; skip what we already have.
  let processed = 0;
  let index = 0;
  source.onopen = () => (index = 0);
  source.onmessage = (message) => {
    if (index++ < processed) return;
    processed++;
    handle(JSON.parse(message.data));
    if (state.run.phase === 'done') source.close();
  };
  source.onerror = () => {
    if (state.run.phase === 'done') return source.close();
    if (source.readyState === EventSource.CLOSED) {
      handle({ type: 'output', execId: null, stream: 'error', text: 'Verbindung zu Buildwerk verloren.', t: Date.now() });
      handle({ type: 'run-end', status: 'failed', durationMs: 0, t: Date.now() });
    }
  };
}

/**
 * @param {{startAt?: string, only?: string, paused?: boolean}} [options]
 */
export async function start(options = {}) {
  if (isRunning()) return;
  const { runId } = await api.post('/api/runs', {
    macro: state.macro,
    path: state.path,
    breakpoints: [...state.breakpoints],
    ...options,
  });
  attach(runId);
}

export function control(action) {
  if (!state.run.id || !isRunning()) return Promise.resolve();
  return api.post(`/api/runs/${state.run.id}/control`, { action });
}

// Breakpoints toggled during a run take effect immediately.
on('breakpoints', () => {
  if (state.run.id && isRunning()) {
    api.post(`/api/runs/${state.run.id}/control`, { breakpoints: [...state.breakpoints] }).catch(() => {});
  }
});
