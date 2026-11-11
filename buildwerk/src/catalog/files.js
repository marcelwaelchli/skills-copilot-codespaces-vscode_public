// File system operations, implemented natively so that macros behave the same
// on Windows, macOS and Linux.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationError } from '../errors.js';
import { glob, globAll, hasMagic, splitPattern } from '../glob.js';
import { isDirectory, statOrNull } from '../util.js';
import { collectEntries, createZip, extractZip } from '../zip.js';
import { area, check, code, filePath, select, text, variable } from './fields.js';

const patternHint = 'Muster: * und ? für Namen, ** für beliebig tiefe Ordner.';

/** Drops paths that lie inside an earlier (directory) match, so nothing is handled twice. */
function topLevel(sortedPaths) {
  const kept = [];
  for (const file of sortedPaths) {
    const last = kept[kept.length - 1];
    if (!last || !file.startsWith(last + path.sep)) kept.push(file);
  }
  return kept;
}

function assertSafeToDelete(target) {
  if (target === path.parse(target).root || target === os.homedir()) {
    throw new OperationError(`«${target}» wird aus Sicherheitsgründen nicht gelöscht.`);
  }
}

async function moveEntry(source, target, overwrite) {
  if (!overwrite && (await statOrNull(target))) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (!['EXDEV', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw error;
    await fs.cp(source, target, { recursive: true, force: true });
    await fs.rm(source, { recursive: true, force: true });
  }
  return true;
}

async function copyEntry(source, target, overwrite) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: overwrite });
  return true;
}

/** Shared logic of «Kopieren» and «Verschieben»: works out source → target pairs. */
async function transfer(ctx, p, action, verb) {
  const dest = ctx.path(p.dest);
  let pairs;
  if (hasMagic(p.source)) {
    const { base } = splitPattern(p.source, ctx.baseDir);
    const matches = topLevel(await glob(p.source, ctx.baseDir));
    if (matches.length === 0) throw new OperationError(`Keine Dateien gefunden für «${p.source}».`);
    pairs = matches.map((file) => [file, path.join(dest, p.flatten ? path.basename(file) : path.relative(base, file))]);
  } else {
    const source = ctx.path(p.source);
    const stat = await statOrNull(source);
    if (!stat) throw new OperationError(`Quelle «${source}» existiert nicht.`);
    const intoDirectory = stat.isFile() && (/[\\/]$/.test(p.dest) || (await isDirectory(dest)));
    pairs = [[source, intoDirectory ? path.join(dest, path.basename(source)) : dest]];
  }
  let count = 0;
  for (const [source, target] of pairs) {
    if (await action(source, target, p.overwrite)) count++;
    else ctx.log(`Übersprungen (existiert bereits): ${target}`);
  }
  ctx.log(`${count} ${count === 1 ? 'Eintrag' : 'Einträge'} ${verb} nach ${dest}`);
}

const transferFields = [
  filePath('source', 'Quelle', { required: true, placeholder: 'dist/**/*.js', hint: `Datei, Ordner oder Muster. ${patternHint}` }),
  filePath('dest', 'Ziel', { required: true, hint: 'Bei Mustern und bei einem / am Ende ist das Ziel ein Ordner.' }),
  check('overwrite', 'Vorhandene Dateien überschreiben', { default: true }),
  check('flatten', 'Ordnerstruktur verwerfen (nur bei Mustern)', { group: 'advanced' }),
];

export default [
  {
    type: 'file.copy',
    category: 'file',
    label: 'Kopieren',
    icon: 'copy',
    description: 'Kopiert Dateien oder ganze Ordner.',
    fields: transferFields,
    summary: '{source} → {dest}',
    run: (ctx, p) => transfer(ctx, p, copyEntry, 'kopiert'),
  },
  {
    type: 'file.move',
    category: 'file',
    label: 'Verschieben',
    icon: 'move',
    description: 'Verschiebt Dateien oder Ordner bzw. benennt sie um.',
    fields: transferFields,
    summary: '{source} → {dest}',
    run: (ctx, p) => transfer(ctx, p, moveEntry, 'verschoben'),
  },
  {
    type: 'file.delete',
    category: 'file',
    label: 'Löschen',
    icon: 'trash',
    description: 'Löscht Dateien und Ordner samt Inhalt.',
    fields: [
      area('paths', 'Pfade oder Muster', { required: true, placeholder: 'dist\nbuild/**/*.tmp', hint: `Eine Angabe pro Zeile. ${patternHint}` }),
      check('mustExist', 'Fehler, wenn nichts gefunden wird'),
    ],
    summary: '{paths}',
    async run(ctx, p) {
      const targets = topLevel(await globAll(p.paths, ctx.baseDir));
      if (targets.length === 0) {
        if (p.mustExist) throw new OperationError('Nichts zu löschen gefunden.');
        ctx.log('Nichts zu löschen gefunden.');
        return;
      }
      for (const target of targets) {
        assertSafeToDelete(target);
        await fs.rm(target, { recursive: true, force: true });
        ctx.log(`Gelöscht: ${target}`);
      }
    },
  },
  {
    type: 'file.mkdir',
    category: 'file',
    label: 'Ordner erstellen',
    icon: 'folderplus',
    description: 'Legt einen Ordner an, inklusive aller fehlenden übergeordneten Ordner.',
    fields: [filePath('path', 'Ordner', { required: true }), check('clean', 'Vorhandenen Inhalt vorher löschen')],
    summary: '{path}',
    async run(ctx, p) {
      const target = ctx.path(p.path);
      if (p.clean) {
        assertSafeToDelete(target);
        await fs.rm(target, { recursive: true, force: true });
      }
      await fs.mkdir(target, { recursive: true });
    },
  },
  {
    type: 'file.write',
    category: 'file',
    label: 'Datei schreiben',
    icon: 'edit',
    description: 'Schreibt Text in eine Datei. Variablen im Inhalt werden ersetzt.',
    fields: [
      filePath('file', 'Datei', { required: true }),
      code('content', 'Inhalt'),
      select('mode', 'Modus', [
        { value: 'overwrite', label: 'Überschreiben', short: '' },
        { value: 'append', label: 'Anhängen', short: '(anhängen)' },
      ]),
    ],
    summary: '{file} {mode}',
    async run(ctx, p) {
      const target = ctx.path(p.file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const content = p.content ?? '';
      if (p.mode === 'append') await fs.appendFile(target, content);
      else await fs.writeFile(target, content);
    },
  },
  {
    type: 'file.read',
    category: 'file',
    label: 'Datei lesen',
    icon: 'file',
    description: 'Liest den Inhalt einer Textdatei in eine Variable.',
    fields: [
      filePath('file', 'Datei', { required: true }),
      variable('variable', 'In Variable speichern', { required: true }),
      check('trim', 'Leerraum am Anfang und Ende entfernen', { default: true }),
    ],
    summary: '{file} → {variable}',
    async run(ctx, p) {
      let content;
      try {
        content = await fs.readFile(ctx.path(p.file), 'utf8');
      } catch (error) {
        throw new OperationError(`Datei «${p.file}» konnte nicht gelesen werden: ${error.message}`);
      }
      ctx.vars.set(p.variable, p.trim ? content.trim() : content);
    },
  },
  {
    type: 'file.replace',
    category: 'file',
    label: 'Text ersetzen',
    icon: 'search',
    description: 'Sucht und ersetzt Text in einer oder mehreren Dateien – etwa um Versionsnummern einzutragen.',
    fields: [
      area('files', 'Dateien oder Muster', { required: true, hint: `Eine Angabe pro Zeile. ${patternHint}` }),
      text('search', 'Suchen nach', { required: true }),
      text('replace', 'Ersetzen durch'),
      check('regex', 'Regulärer Ausdruck', { hint: 'Im Ersatztext stehen $1, $2 … für Gruppen.' }),
      check('ignoreCase', 'Gross-/Kleinschreibung ignorieren'),
      check('mustMatch', 'Fehler, wenn nichts ersetzt wurde'),
    ],
    summary: '«{search}» → «{replace}» in {files}',
    async run(ctx, p) {
      let pattern;
      try {
        const source = p.regex ? p.search : p.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pattern = new RegExp(source, p.ignoreCase ? 'gi' : 'g');
      } catch (error) {
        throw new OperationError(`Ungültiger regulärer Ausdruck: ${error.message}`);
      }
      const replacement = p.regex ? p.replace ?? '' : (p.replace ?? '').replace(/\$/g, '$$$$');
      let total = 0;
      for (const file of await globAll(p.files, ctx.baseDir)) {
        if (!(await statOrNull(file))?.isFile()) continue;
        const before = await fs.readFile(file, 'utf8');
        const hits = before.match(pattern)?.length || 0;
        if (hits === 0) continue;
        await fs.writeFile(file, before.replace(pattern, replacement));
        ctx.log(`${hits}× ersetzt in ${file}`);
        total += hits;
      }
      if (total === 0) {
        if (p.mustMatch) throw new OperationError(`«${p.search}» wurde in keiner Datei gefunden.`);
        ctx.log('Keine Treffer.');
      }
    },
  },
  {
    type: 'file.zip',
    category: 'file',
    label: 'ZIP erstellen',
    icon: 'archive',
    description: 'Packt einen Ordner, eine Datei oder alle Treffer eines Musters in ein ZIP-Archiv.',
    fields: [
      filePath('source', 'Quelle', { required: true, placeholder: 'dist', hint: `Ordner (Inhalt wird gepackt), Datei oder Muster. ${patternHint}` }),
      filePath('dest', 'ZIP-Datei', { required: true, placeholder: 'release/app-${VERSION}.zip' }),
      text('prefix', 'Ordner im Archiv', { group: 'advanced', hint: 'Legt alle Einträge in diesen Unterordner des Archivs.' }),
    ],
    summary: '{source} → {dest}',
    async run(ctx, p) {
      const dest = ctx.path(p.dest);
      let entries = [];
      if (hasMagic(p.source)) {
        const { base } = splitPattern(p.source, ctx.baseDir);
        for (const file of await glob(p.source, ctx.baseDir)) {
          if ((await statOrNull(file))?.isFile()) entries.push({ name: path.relative(base, file).split(path.sep).join('/'), file });
        }
      } else {
        const source = ctx.path(p.source);
        const stat = await statOrNull(source);
        if (!stat) throw new OperationError(`Quelle «${source}» existiert nicht.`);
        entries = stat.isDirectory() ? await collectEntries(source) : [{ name: path.basename(source), file: source }];
      }
      entries = entries.filter((entry) => entry.file !== dest);
      if (entries.length === 0) throw new OperationError(`Nichts zu packen gefunden in «${p.source}».`);
      const prefix = (p.prefix || '').replace(/^[\\/]+|[\\/]+$/g, '');
      if (prefix) entries = entries.map((entry) => ({ ...entry, name: `${prefix}/${entry.name}` }));
      const count = await createZip(dest, entries);
      const size = (await fs.stat(dest)).size;
      ctx.log(`${count} ${count === 1 ? 'Eintrag' : 'Einträge'} gepackt, ${(size / 1024).toFixed(1)} KB: ${dest}`);
    },
  },
  {
    type: 'file.unzip',
    category: 'file',
    label: 'ZIP entpacken',
    icon: 'unarchive',
    description: 'Entpackt ein ZIP-Archiv in einen Ordner.',
    fields: [
      filePath('file', 'ZIP-Datei', { required: true }),
      filePath('dest', 'Zielordner', { required: true }),
      check('clean', 'Zielordner vorher leeren'),
    ],
    summary: '{file} → {dest}',
    async run(ctx, p) {
      const file = ctx.path(p.file);
      if (!(await statOrNull(file))) throw new OperationError(`ZIP-Datei «${file}» existiert nicht.`);
      const dest = ctx.path(p.dest);
      if (p.clean) {
        assertSafeToDelete(dest);
        await fs.rm(dest, { recursive: true, force: true });
      }
      const count = await extractZip(file, dest);
      ctx.log(`${count} ${count === 1 ? 'Datei' : 'Dateien'} entpackt nach ${dest}`);
    },
  },
];
