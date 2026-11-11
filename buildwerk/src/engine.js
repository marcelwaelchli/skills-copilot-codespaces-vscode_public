// Executes a macro: walks the operation tree, resolves variables, handles flow
// control and reports everything that happens as a stream of events.

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { catalog, SYSTEM_VARIABLES } from './catalog/index.js';
import { BreakSignal, CancelledError, ContinueSignal, ControlSignal, OperationError, StopSignal, toOperationError } from './errors.js';
import { globAll } from './glob.js';
import { formatCommand, runProcess } from './process.js';
import { VAR_NAME, contains, effectiveProps, findOp, isFieldVisible, opLabel, opTitle, substitute, walk } from './shared/model.js';
import { validateMacro } from './shared/validate.js';
import { parseKeyValues, statOrNull } from './util.js';

const SYSTEM_NAMES = new Set(SYSTEM_VARIABLES.map((v) => v.name));
const MAX_MACRO_DEPTH = 10;
const TEXT_KEYS = ['text', 'label', 'error', 'value'];

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Decodes a file written by a child process. Windows PowerShell's `>>` writes
 * UTF-16 with a byte order mark; everything else is treated as UTF-8.
 */
function decodeText(buffer) {
  const utf16 = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  return buffer.toString(utf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '');
}

/** Groups if/else-if/else and try/catch/finally siblings into one unit each. */
function chainUnits(ops) {
  const units = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'flow.if') {
      const chain = [op];
      while (ops[i + 1] && (ops[i + 1].type === 'flow.elseif' || ops[i + 1].type === 'flow.else')) chain.push(ops[++i]);
      units.push({ kind: 'if', chain });
    } else if (op.type === 'flow.try') {
      const unit = { kind: 'try', tryOp: op };
      if (ops[i + 1]?.type === 'flow.catch') unit.catchOp = ops[++i];
      if (ops[i + 1]?.type === 'flow.finally') unit.finallyOp = ops[++i];
      units.push(unit);
    } else {
      units.push({ kind: 'op', op });
    }
  }
  return units;
}

export class MacroRun extends EventEmitter {
  /**
   * @param {object} macro
   * @param {object} [options]
   * @param {string} [options.macroFile] file the macro was loaded from
   * @param {string} [options.workspace] fallback base for macros that were never saved
   * @param {Record<string,string>} [options.overrides] variable values that win over the defaults
   * @param {string[]} [options.breakpoints] operation ids to pause at
   * @param {string} [options.startAt] skip everything before this operation
   * @param {string} [options.only] run just this operation (with its children)
   * @param {boolean} [options.paused] pause before the first operation
   */
  constructor(macro, options = {}) {
    super();
    this.macro = macro;
    this.options = options;
    this.parent = options.parent || null;
    this.root = this.parent ? this.parent.root : this;
    this.depth = this.parent ? this.parent.depth + 1 : 0;
    this.id = options.runId || randomBytes(6).toString('hex');
    this.vars = new Map();
    this.secretNames = new Set();
    this.seeking = null;
    if (!this.parent) {
      this.abort = new AbortController();
      this.execCounter = 0;
      this.breakpoints = new Set(options.breakpoints || []);
      this.stepping = Boolean(options.paused);
      this.waiters = [];
      this.secretValues = new Set();
    }
  }

  // ---------------------------------------------------------------- control

  stop() {
    this.root.abort.abort();
    this.#release(new CancelledError());
  }

  setBreakpoints(ids) {
    this.root.breakpoints = new Set(ids);
  }

  /** Pause before the next operation starts. */
  pause() {
    this.root.stepping = true;
  }

  resume() {
    this.root.stepping = false;
    this.#release();
  }

  step() {
    this.root.stepping = true;
    this.#release();
  }

  #release(error) {
    const waiters = this.root.waiters.splice(0);
    for (const waiter of waiters) (error ? waiter.reject(error) : waiter.resolve());
  }

  async #gate(op) {
    const root = this.root;
    if (!root.stepping && !root.breakpoints.has(op.id)) return;
    root.stepping = false;
    this.emitEvent('paused', { opId: op.id });
    await new Promise((resolve, reject) => root.waiters.push({ resolve, reject }));
    this.emitEvent('resumed', {});
  }

  #checkCancelled() {
    if (this.root.abort.signal.aborted) throw new CancelledError();
  }

  // ----------------------------------------------------------------- events

  mask(text) {
    let result = String(text);
    for (const secret of this.root.secretValues) result = result.split(secret).join('***');
    return result;
  }

  emitEvent(type, data) {
    const event = { type, t: Date.now(), ...data };
    for (const key of TEXT_KEYS) if (typeof event[key] === 'string') event[key] = this.mask(event[key]);
    this.root.emit('event', event);
  }

  output(exec, stream, text) {
    this.emitEvent('output', { execId: exec?.id ?? null, stream, text: String(text) });
  }

  #begin(op, parentExec) {
    const def = catalog.get(op.type);
    // Operations whose output repeats their summary are listed by title only.
    const label = def.plainLogLabel ? opTitle(def, op) : opLabel(def, op);
    const exec = { id: ++this.root.execCounter, opId: op.id, started: Date.now(), label: this.subst(label) };
    this.emitEvent('op-start', { execId: exec.id, parentExecId: parentExec?.id ?? null, opId: op.id, opType: op.type, label: exec.label });
    return exec;
  }

  #end(exec, status, error) {
    const event = { execId: exec.id, opId: exec.opId, status, durationMs: Date.now() - exec.started };
    if (error && !error.reported) {
      event.error = error.message;
      error.reported = true;
    }
    this.emitEvent('op-end', event);
  }

  #skip(op) {
    if (!op || op.enabled === false) return;
    for (const entry of walk([op])) {
      if (entry.op.enabled !== false) this.emitEvent('op-skip', { opId: entry.op.id });
    }
  }

  // -------------------------------------------------------------- variables

  lookup = (name) => {
    if (name.startsWith('env:')) return process.env[name.slice(4)] ?? '';
    return this.vars.get(name);
  };

  /** Lenient: unknown references stay in the text (labels, shell scripts). */
  subst(text) {
    return substitute(text, this.lookup);
  }

  /** Strict: a reference to a variable that does not exist is an error, not a silent literal. */
  substStrict(text, where) {
    return substitute(text, this.lookup, (name) => {
      throw new OperationError(`Variable «${name}» ist nicht definiert (${where}).`);
    });
  }

  getVar(name) {
    return this.vars.get(name);
  }

  setVar(name, value) {
    if (!VAR_NAME.test(name)) throw new OperationError(`«${name}» ist kein gültiger Variablenname.`);
    const text = String(value ?? '');
    this.vars.set(name, text);
    const secret = this.secretNames.has(name);
    if (secret && text.length >= 3) this.root.secretValues.add(text);
    this.emitEvent('var', { name, value: secret ? '***' : text, system: SYSTEM_NAMES.has(name) });
  }

  /** Environment for child processes: user variables are visible as environment variables. */
  childEnv(extra = {}) {
    const env = { ...process.env };
    for (const [name, value] of this.vars) if (!SYSTEM_NAMES.has(name)) env[name] = value;
    env.BUILDWERK = '1';
    env.BUILDWERK_RUN_ID = this.root.id;
    env.BUILDWERK_BASE_DIR = this.baseDir;
    env.BUILDWERK_TEMP_DIR = this.tmpDir;
    return { ...env, ...extra };
  }

  resolvePath(file) {
    return path.resolve(this.baseDir, String(file || '.'));
  }

  resolveProps(op) {
    const def = catalog.get(op.type);
    const raw = effectiveProps(def, op);
    const props = {};
    for (const field of def.fields) {
      if (!isFieldVisible(field, raw)) continue;
      let value = raw[field.key];
      if (typeof value === 'string' && !field.raw) {
        // In scripts ${...} may belong to the shell, so unknown names pass through there.
        value = field.passthrough ? this.subst(value) : this.substStrict(value, `Feld «${field.label}»`);
      }
      if (field.type === 'number') {
        if (value === undefined || value === null || String(value).trim() === '') value = undefined;
        else {
          const number = Number(value);
          if (Number.isNaN(number)) throw new OperationError(`Feld «${field.label}»: «${value}» ist keine Zahl.`);
          value = number;
        }
      } else if (field.type === 'checkbox') {
        value = value === true || value === 'true';
      }
      props[field.key] = value;
    }
    return props;
  }

  async #init() {
    const { options, macro } = this;
    const macroFile = options.macroFile ? path.resolve(options.macroFile) : null;
    const macroDir = macroFile ? path.dirname(macroFile) : path.resolve(options.workspace || process.cwd());
    this.workspace = path.resolve(options.workspace || macroDir);
    this.baseDir = path.resolve(macroDir, macro.baseDir || '.');
    this.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwerk-'));
    this.stateFile = macroFile ? macroFile.replace(/\.json$/i, '') + '.state.json' : null;

    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const system = {
      MACRO_NAME: macro.name || '',
      MACRO_FILE: macroFile || '',
      MACRO_DIR: macroDir,
      BASE_DIR: this.baseDir,
      WORKSPACE: this.workspace,
      TEMP_DIR: this.tmpDir,
      OS: { win32: 'windows', darwin: 'macos' }[process.platform] || 'linux',
      DATE: date,
      TIME: time,
      TIMESTAMP: `${date.replaceAll('-', '')}-${time.replaceAll(':', '')}`,
      RUN_ID: this.root.id,
      LAST_EXIT_CODE: '0',
      ERROR_MESSAGE: '',
      ERROR_OPERATION: '',
      LOOP_INDEX: '0',
    };
    for (const [name, value] of Object.entries(system)) this.vars.set(name, value);

    let persisted = {};
    if (this.stateFile) {
      try {
        persisted = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      } catch {
        // no state yet
      }
    }
    const overrides = options.overrides || {};
    for (const variable of macro.variables || []) {
      const { name } = variable;
      if (variable.secret) this.secretNames.add(name);
      let value;
      if (name in overrides) value = overrides[name];
      else if (variable.persistent && name in persisted) value = persisted[name];
      else if (variable.secret && !variable.value && process.env[name] !== undefined) value = process.env[name];
      else value = this.substStrict(variable.value ?? '', `Standardwert von «${name}»`);
      this.setVar(name, value);
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (!this.vars.has(name)) this.setVar(name, value);
    }
  }

  async #persist() {
    const names = (this.macro.variables || []).filter((v) => v.persistent && !v.secret).map((v) => v.name);
    if (!this.stateFile || names.length === 0) return;
    const state = Object.fromEntries(names.map((name) => [name, this.vars.get(name) ?? '']));
    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2) + '\n');
  }

  // -------------------------------------------------------------- execution

  /** Runs the macro and resolves with the outcome; never rejects. */
  async run() {
    const started = Date.now();
    this.emitEvent('run-start', { runId: this.id, macro: this.macro.name || '', file: this.options.macroFile || null });
    let status = 'success';
    let error;
    try {
      await this.execute(null);
    } catch (caught) {
      if (caught instanceof CancelledError) {
        status = 'cancelled';
      } else {
        status = 'failed';
        error = caught.message;
        if (!caught.reported) this.output(null, 'error', caught.message);
      }
    }
    const durationMs = Date.now() - started;
    this.emitEvent('run-end', { status, durationMs, error });
    return { status, error, durationMs };
  }

  /** Validates, initialises variables and executes the operations. Throws on failure. */
  async execute(parentExec) {
    if (this.depth > MAX_MACRO_DEPTH) throw new OperationError('Makros sind zu tief verschachtelt (Endlosschleife?).');
    const errors = validateMacro(this.macro, catalog, [...SYSTEM_NAMES]).filter((p) => p.level === 'error');
    if (errors.length) {
      const lines = errors.map((problem) => {
        const entry = problem.opId && findOp(this.macro, problem.opId);
        const where = entry ? `${opLabel(catalog.get(entry.op.type), entry.op)}: ` : '';
        return `• ${where}${problem.message}`;
      });
      throw new OperationError(`Das Makro enthält Fehler:\n${lines.join('\n')}`);
    }

    await this.#init();
    try {
      let ops = this.macro.operations || [];
      const { only, startAt } = this.options;
      if (only) {
        const entry = findOp(this.macro, only);
        if (!entry) throw new OperationError('Die ausgewählte Operation existiert nicht mehr.');
        ops = [{ ...entry.op, enabled: true }];
      } else if (startAt) {
        const entry = findOp(this.macro, startAt);
        if (!entry) throw new OperationError('Der Startpunkt existiert nicht mehr.');
        if (entry.op.enabled === false) throw new OperationError('Der Startpunkt ist deaktiviert.');
        this.seeking = startAt;
      }
      await this.#execList(ops, parentExec);
      if (this.seeking) throw new OperationError('Der Startpunkt wurde nicht erreicht (liegt er in einem deaktivierten Block?).');
    } catch (error) {
      if (!(error instanceof StopSignal)) throw error;
    } finally {
      await this.#persist().catch((error) => this.output(null, 'warn', `Persistente Variablen konnten nicht gespeichert werden: ${error.message}`));
      await fs.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #execList(ops, parentExec) {
    for (const unit of chainUnits(ops)) await this.#execUnit(unit, parentExec);
  }

  #execUnit(unit, parentExec) {
    if (unit.kind === 'if') return this.#execIfChain(unit.chain, parentExec);
    if (unit.kind === 'try') return this.#execTryChain(unit, parentExec);
    return this.#execOp(unit.op, parentExec);
  }

  /**
   * Runs one operation with all the bookkeeping around it: enabled state,
   * «run from here», breakpoints, status events and error policy.
   * `body` replaces the default behaviour (used by if/try chains).
   */
  async #execOp(op, parentExec, body) {
    if (op.enabled === false) return;
    const children = (exec) => this.#execList(op.children || [], exec);

    if (this.seeking) {
      if (op.id === this.seeking) {
        this.seeking = null;
      } else if (contains(op, this.seeking)) {
        // The start point is somewhere inside: enter the block without running its own logic.
        body = children;
      } else {
        this.#skip(op);
        return;
      }
    }

    this.#checkCancelled();
    if (!this.seeking) await this.#gate(op);
    const exec = this.#begin(op, parentExec);
    try {
      await (body ? body(exec) : this.#dispatch(op, exec));
      this.#end(exec, 'success');
    } catch (caught) {
      if (caught instanceof CancelledError) {
        this.#end(exec, 'cancelled');
        throw caught;
      }
      if (caught instanceof ControlSignal) {
        this.#end(exec, 'success');
        throw caught;
      }
      const error = toOperationError(caught);
      if (!error.opLabel) error.opLabel = exec.label;
      if (op.onError === 'continue') {
        this.#end(exec, 'warning', error);
        this.output(exec, 'warn', 'Fehler ignoriert – Makro wird fortgesetzt.');
        return;
      }
      this.#end(exec, 'failed', error);
      throw error;
    }
  }

  async #execIfChain(chain, parentExec) {
    if (chain[0].enabled === false) return;
    const block = (op) => (exec) => this.#execList(op.children || [], exec);

    if (this.seeking && this.seeking !== chain[0].id) {
      // Start point inside one of the branches: enter that branch only.
      let found = false;
      for (const member of chain) {
        if (found) this.#skip(member);
        else {
          await this.#execOp(member, parentExec, block(member));
          found = !this.seeking;
        }
      }
      return;
    }

    let taken = false;
    for (const member of chain) {
      if (member.enabled === false) continue;
      if (taken) {
        this.#skip(member);
      } else if (member.type === 'flow.else') {
        taken = true;
        await this.#execOp(member, parentExec, block(member));
      } else {
        await this.#execOp(member, parentExec, async (exec) => {
          taken = await this.#evalCondition(member);
          this.output(exec, 'info', taken ? 'Bedingung erfüllt' : 'Bedingung nicht erfüllt');
          if (taken) await this.#execList(member.children || [], exec);
          else (member.children || []).forEach((child) => this.#skip(child));
        });
      }
    }
  }

  async #execTryChain({ tryOp, catchOp, finallyOp }, parentExec) {
    if (tryOp.enabled === false) return;
    const block = (op) => this.#execOp(op, parentExec, (exec) => this.#execList(op.children || [], exec));

    if (this.seeking && this.seeking !== tryOp.id && !contains(tryOp, this.seeking)) {
      this.#skip(tryOp);
      if (catchOp) await block(catchOp);
      if (finallyOp) await block(finallyOp);
      return;
    }

    let pending = null;
    try {
      await block(tryOp);
    } catch (error) {
      if (error instanceof ControlSignal) throw error;
      pending = error;
    }
    if (pending && catchOp && catchOp.enabled !== false) {
      this.setVar('ERROR_MESSAGE', pending.message);
      this.setVar('ERROR_OPERATION', pending.opLabel || '');
      pending = null;
      try {
        await block(catchOp);
      } catch (error) {
        if (error instanceof ControlSignal) throw error;
        pending = error;
      }
    } else {
      this.#skip(catchOp);
    }
    if (finallyOp) await block(finallyOp);
    if (pending) throw pending;
  }

  async #evalCondition(op) {
    const p = this.resolveProps(op);
    const left = String(p.left ?? '');
    const right = String(p.right ?? '');
    const fold = (text) => (p.ignoreCase ? text.toLowerCase() : text);
    const numbers = () => {
      const a = Number(left);
      const b = Number(right);
      if (left.trim() === '' || right.trim() === '' || Number.isNaN(a) || Number.isNaN(b)) {
        throw new OperationError(`Zahlenvergleich nicht möglich: «${left}» und «${right}».`);
      }
      return [a, b];
    };
    switch (p.operator) {
      case 'equals': return fold(left) === fold(right);
      case 'notEquals': return fold(left) !== fold(right);
      case 'contains': return fold(left).includes(fold(right));
      case 'notContains': return !fold(left).includes(fold(right));
      case 'startsWith': return fold(left).startsWith(fold(right));
      case 'endsWith': return fold(left).endsWith(fold(right));
      case 'matches':
        try {
          return new RegExp(right, p.ignoreCase ? 'i' : '').test(left);
        } catch (error) {
          throw new OperationError(`Ungültiger regulärer Ausdruck: ${error.message}`);
        }
      case 'gt': { const [a, b] = numbers(); return a > b; }
      case 'ge': { const [a, b] = numbers(); return a >= b; }
      case 'lt': { const [a, b] = numbers(); return a < b; }
      case 'le': { const [a, b] = numbers(); return a <= b; }
      case 'isEmpty': return left.trim() === '';
      case 'isNotEmpty': return left.trim() !== '';
      case 'fileExists': return Boolean((await statOrNull(this.resolvePath(left)))?.isFile());
      case 'dirExists': return Boolean((await statOrNull(this.resolvePath(left)))?.isDirectory());
      case 'notExists': return !(await statOrNull(this.resolvePath(left)));
      default: throw new OperationError(`Unbekannte Bedingung «${p.operator}».`);
    }
  }

  /** Runs the loop body once; returns false when the loop should end. */
  async #iteration(op, exec, index, note) {
    this.#checkCancelled();
    this.setVar('LOOP_INDEX', index);
    this.output(exec, 'info', `Durchlauf ${index}${note ? ` – ${note}` : ''}`);
    try {
      await this.#execList(op.children || [], exec);
    } catch (error) {
      if (error instanceof BreakSignal) return false;
      if (!(error instanceof ContinueSignal)) throw error;
    }
    return true;
  }

  async #dispatch(op, exec) {
    switch (op.type) {
      case 'flow.group':
      case 'flow.if':
      case 'flow.elseif':
      case 'flow.else':
      case 'flow.try':
      case 'flow.catch':
      case 'flow.finally':
        return this.#execList(op.children || [], exec);

      case 'flow.foreach': {
        const p = this.resolveProps(op);
        let items;
        if (p.source === 'files') {
          items = await globAll(p.pattern, this.baseDir);
        } else if (p.source === 'range') {
          const step = p.step || 1;
          if (step <= 0) throw new OperationError('Die Schrittweite muss grösser als 0 sein.');
          items = [];
          for (let n = p.from ?? 1; n <= (p.to ?? 1); n += step) items.push(String(n));
        } else {
          const separator = p.separator ? p.separator.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : '\n';
          items = String(p.items ?? '').split(separator).map((item) => item.trim()).filter(Boolean);
        }
        if (items.length === 0) this.output(exec, 'info', 'Keine Elemente – Schleife wird übersprungen.');
        for (let i = 0; i < items.length; i++) {
          this.setVar(p.variable, items[i]);
          if (!(await this.#iteration(op, exec, i + 1, `${p.variable} = ${items[i]}`))) break;
        }
        return;
      }

      case 'flow.while': {
        const limit = this.resolveProps(op).maxIterations ?? 1000;
        for (let i = 1; await this.#evalCondition(op); i++) {
          if (i > limit) throw new OperationError(`Schleife nach ${limit} Durchläufen abgebrochen (Maximum erreicht).`);
          if (!(await this.#iteration(op, exec, i))) break;
        }
        return;
      }

      case 'flow.parallel': {
        const units = chainUnits(op.children || []);
        const results = await Promise.allSettled(units.map((unit) => this.#execUnit(unit, exec)));
        const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
        const failure = failures.find((error) => error instanceof ControlSignal) || failures[0];
        if (failure) throw failure;
        return;
      }

      case 'flow.runmacro': {
        const p = this.resolveProps(op);
        const file = this.resolvePath(p.file);
        let macro;
        try {
          macro = JSON.parse(await fs.readFile(file, 'utf8'));
        } catch (error) {
          throw new OperationError(`Makro «${p.file}» konnte nicht geladen werden: ${error.message}`);
        }
        const child = new MacroRun(macro, {
          parent: this,
          macroFile: file,
          workspace: this.workspace,
          overrides: parseKeyValues(p.variables),
        });
        return child.execute(exec);
      }

      default: {
        const def = catalog.get(op.type);
        return def.run(this.#context(op, exec), this.resolveProps(op));
      }
    }
  }

  /** The API that operation implementations in the catalog work against. */
  #context(op, exec) {
    const run = this;
    return {
      named: Boolean(op.name?.trim()),
      baseDir: run.baseDir,
      tmpDir: run.tmpDir,
      signal: run.root.abort.signal,
      platform: process.platform,
      log: (text, level = 'info') => run.output(exec, level, text),
      fail: (message) => {
        throw new OperationError(message);
      },
      path: (file) => run.resolvePath(file),
      vars: {
        get: (name) => run.getVar(name),
        set: (name, value) => run.setVar(name, value),
        all: () => Object.fromEntries(run.vars),
      },
      processOptions: (p) => ({ cwd: p.cwd, env: parseKeyValues(p.env), timeoutSec: p.timeout }),
      exec: (cmd, args, options) => run.#execProcess(exec, cmd, args, options),
    };
  }

  async #execProcess(exec, cmd, args, { cwd, env, timeoutSec, okCodes = [0], capture = false, verbatim = false, echo = true, quiet = false } = {}) {
    const workdir = cwd ? this.resolvePath(cwd) : this.baseDir;
    if (echo) this.output(exec, 'command', `$ ${formatCommand(cmd, args)}`);
    const varsFile = path.join(this.tmpDir, `vars-${exec.id}.txt`);
    const captured = [];
    const { code } = await runProcess({
      cmd,
      args,
      cwd: workdir,
      env: this.childEnv({ ...env, BUILDWERK_VARS: varsFile }),
      signal: this.root.abort.signal,
      timeoutMs: timeoutSec ? timeoutSec * 1000 : 0,
      verbatim,
      onLine: (line, stream) => {
        if (capture && stream === 'stdout') captured.push(line);
        if (!quiet) this.output(exec, stream, line);
      },
    });
    this.setVar('LAST_EXIT_CODE', code);

    // Processes hand variables back by appending NAME=value lines to $BUILDWERK_VARS.
    const handedBack = decodeText(await fs.readFile(varsFile).catch(() => Buffer.alloc(0)));
    for (const [name, value] of Object.entries(parseKeyValues(handedBack))) {
      if (VAR_NAME.test(name)) this.setVar(name, value);
      else this.output(exec, 'warn', `Ungültiger Variablenname in BUILDWERK_VARS: «${name}»`);
    }

    if (!okCodes.includes(code)) {
      throw new OperationError(`«${cmd}» wurde mit Exit-Code ${code} beendet.`, { exitCode: code });
    }
    return { code, stdout: captured.join('\n') };
  }
}
