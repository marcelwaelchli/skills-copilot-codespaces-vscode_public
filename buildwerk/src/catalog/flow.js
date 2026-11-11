// Flow control. The structural operations (blocks, conditions, loops, try,
// parallel, sub-macro) are executed by the engine itself; only the simple ones
// carry a `run` function here.

import { BreakSignal, CancelledError, ContinueSignal, OperationError, StopSignal } from '../errors.js';
import { area, check, filePath, number, select, text, variable } from './fields.js';

const UNARY = ['isEmpty', 'isNotEmpty', 'fileExists', 'dirExists', 'notExists'];
const TEXTUAL = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches'];

const conditionFields = [
  text('left', 'Wert', { required: true, placeholder: '${VARIABLE} oder Pfad' }),
  select('operator', 'Bedingung', [
    { value: 'equals', label: 'ist gleich', short: '=' },
    { value: 'notEquals', label: 'ist ungleich', short: '≠' },
    { value: 'contains', label: 'enthält', short: 'enthält' },
    { value: 'notContains', label: 'enthält nicht', short: 'enthält nicht' },
    { value: 'startsWith', label: 'beginnt mit', short: 'beginnt mit' },
    { value: 'endsWith', label: 'endet mit', short: 'endet mit' },
    { value: 'matches', label: 'passt auf regulären Ausdruck', short: 'passt auf' },
    { value: 'gt', label: 'grösser als (Zahl)', short: '>' },
    { value: 'ge', label: 'grösser oder gleich (Zahl)', short: '≥' },
    { value: 'lt', label: 'kleiner als (Zahl)', short: '<' },
    { value: 'le', label: 'kleiner oder gleich (Zahl)', short: '≤' },
    { value: 'isEmpty', label: 'ist leer', short: 'ist leer' },
    { value: 'isNotEmpty', label: 'ist nicht leer', short: 'ist nicht leer' },
    { value: 'fileExists', label: 'Datei existiert', short: 'ist eine vorhandene Datei' },
    { value: 'dirExists', label: 'Ordner existiert', short: 'ist ein vorhandener Ordner' },
    { value: 'notExists', label: 'Pfad existiert nicht', short: 'existiert nicht' },
  ]),
  text('right', 'Vergleichswert', { showIf: { key: 'operator', notIn: UNARY } }),
  check('ignoreCase', 'Gross-/Kleinschreibung ignorieren', { showIf: { key: 'operator', in: TEXTUAL } }),
];
const conditionSummary = '{left} {operator} {right}';

const block = (def) => ({ category: 'flow', container: true, fields: [], ...def });

export default [
  block({
    type: 'flow.group',
    label: 'Gruppe',
    icon: 'layers',
    description: 'Fasst Operationen zu einem benannten Abschnitt zusammen.',
  }),
  block({
    type: 'flow.if',
    label: 'Wenn',
    icon: 'diamond',
    description: 'Führt die enthaltenen Operationen nur aus, wenn die Bedingung erfüllt ist.',
    fields: conditionFields,
    summary: conditionSummary,
  }),
  block({
    type: 'flow.elseif',
    label: 'Sonst wenn',
    icon: 'diamond',
    description: 'Wird geprüft, wenn die vorangehende Bedingung nicht erfüllt war. Muss direkt auf «Wenn» folgen.',
    fields: conditionFields,
    summary: conditionSummary,
  }),
  block({
    type: 'flow.else',
    label: 'Sonst',
    icon: 'corner',
    description: 'Wird ausgeführt, wenn keine der vorangehenden Bedingungen erfüllt war.',
  }),
  block({
    type: 'flow.foreach',
    label: 'Für jedes',
    icon: 'repeat',
    description: 'Wiederholt die enthaltenen Operationen für jeden Wert einer Liste, jede gefundene Datei oder jede Zahl eines Bereichs.',
    fields: [
      select('source', 'Durchlaufen', [
        { value: 'list', label: 'Liste von Werten' },
        { value: 'files', label: 'Dateien und Ordner (Muster)' },
        { value: 'range', label: 'Zahlenbereich' },
      ]),
      area('items', 'Werte', { required: true, placeholder: 'ein Wert pro Zeile', showIf: { key: 'source', equals: 'list' } }),
      text('separator', 'Trennzeichen', { group: 'advanced', placeholder: 'Zeilenumbruch', hint: 'Leer = ein Wert pro Zeile. \\n und \\t sind erlaubt.', showIf: { key: 'source', equals: 'list' } }),
      area('pattern', 'Muster', { required: true, placeholder: 'src/**/*.csproj', hint: '* und ? für Namen, ** für beliebig tiefe Ordner. Ein Muster pro Zeile, ! schliesst aus.', showIf: { key: 'source', equals: 'files' } }),
      number('from', 'Von', { default: '1', required: true, showIf: { key: 'source', equals: 'range' } }),
      number('to', 'Bis', { default: '3', required: true, showIf: { key: 'source', equals: 'range' } }),
      number('step', 'Schrittweite', { default: '1', showIf: { key: 'source', equals: 'range' } }),
      variable('variable', 'Schleifenvariable', { default: 'ITEM', required: true }),
    ],
    summary: [
      { if: { key: 'source', equals: 'files' }, text: '{variable} in {pattern}' },
      { if: { key: 'source', equals: 'range' }, text: '{variable} von {from} bis {to}' },
      { text: '{variable} in {items}' },
    ],
  }),
  block({
    type: 'flow.while',
    label: 'Solange',
    icon: 'refresh',
    description: 'Wiederholt die enthaltenen Operationen, solange die Bedingung erfüllt ist.',
    fields: [...conditionFields, number('maxIterations', 'Maximale Durchläufe', { default: '1000', group: 'advanced' })],
    summary: conditionSummary,
  }),
  {
    type: 'flow.break',
    category: 'flow',
    label: 'Schleife verlassen',
    icon: 'logout',
    description: 'Beendet die umgebende Schleife sofort.',
    fields: [],
    run() {
      throw new BreakSignal();
    },
  },
  {
    type: 'flow.continue',
    category: 'flow',
    label: 'Nächster Durchlauf',
    icon: 'skip',
    description: 'Überspringt den Rest des aktuellen Schleifendurchlaufs.',
    fields: [],
    run() {
      throw new ContinueSignal();
    },
  },
  block({
    type: 'flow.try',
    label: 'Versuchen',
    icon: 'shield',
    description: 'Fängt Fehler der enthaltenen Operationen ab. Danach können «Bei Fehler» und «Abschliessend» folgen.',
  }),
  block({
    type: 'flow.catch',
    label: 'Bei Fehler',
    icon: 'alert',
    description: 'Wird ausgeführt, wenn im «Versuchen»-Block ein Fehler aufgetreten ist. ${ERROR_MESSAGE} und ${ERROR_OPERATION} beschreiben ihn.',
  }),
  block({
    type: 'flow.finally',
    label: 'Abschliessend',
    icon: 'flag',
    description: 'Wird nach dem «Versuchen»-Block immer ausgeführt – mit oder ohne Fehler. Ideal zum Aufräumen.',
  }),
  block({
    type: 'flow.parallel',
    label: 'Parallel',
    icon: 'columns',
    description: 'Startet alle direkt enthaltenen Operationen gleichzeitig und wartet, bis alle fertig sind.',
  }),
  {
    type: 'flow.runmacro',
    category: 'flow',
    label: 'Makro ausführen',
    icon: 'play',
    description: 'Führt ein anderes Makro als Unterprogramm aus. Dessen Variablen sind von diesem Makro getrennt.',
    fields: [
      filePath('file', 'Makrodatei', { required: true, placeholder: 'gemeinsam/aufraeumen.buildwerk.json' }),
      area('variables', 'Variablen übergeben', { placeholder: 'NAME=Wert (eine pro Zeile)' }),
    ],
    summary: '{file}',
  },
  {
    type: 'flow.delay',
    category: 'flow',
    label: 'Warten',
    icon: 'clock',
    description: 'Hält das Makro für die angegebene Zeit an.',
    fields: [number('seconds', 'Sekunden', { default: '5', required: true })],
    summary: '{seconds} s',
    run(ctx, p) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, Math.max(0, p.seconds ?? 0) * 1000);
        ctx.signal.addEventListener('abort', () => (clearTimeout(timer), reject(new CancelledError())), { once: true });
      });
    },
  },
  {
    type: 'flow.stop',
    category: 'flow',
    label: 'Makro beenden',
    icon: 'stop',
    description: 'Beendet das Makro an dieser Stelle erfolgreich.',
    fields: [text('message', 'Meldung')],
    summary: '{message}',
    run(ctx, p) {
      if (p.message) ctx.log(p.message);
      throw new StopSignal();
    },
  },
  {
    type: 'flow.fail',
    category: 'flow',
    label: 'Fehler auslösen',
    icon: 'xcircle',
    description: 'Bricht mit einer eigenen Fehlermeldung ab. Der Fehler kann von «Versuchen» abgefangen werden.',
    fields: [text('message', 'Fehlermeldung', { required: true, default: 'Makro abgebrochen' })],
    summary: '{message}',
    run(ctx, p) {
      throw new OperationError(p.message);
    },
  },
];
