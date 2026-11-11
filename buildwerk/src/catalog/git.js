// Git operations, built on the git command line.

import fs from 'node:fs/promises';
import { splitArgs } from '../process.js';
import { area, check, filePath, number, text } from './fields.js';

const repo = filePath('repo', 'Repository-Ordner', { placeholder: 'Basisverzeichnis des Makros' });
const timeout = number('timeout', 'Zeitlimit in Sekunden', { group: 'advanced', placeholder: 'kein Limit' });

const git = (def) => ({ category: 'git', ...def, fields: [...def.fields, timeout] });
const options = (p) => ({ cwd: p.repo, timeoutSec: p.timeout });

/** Runs git quietly and returns trimmed stdout, or '' when the command fails. */
async function query(ctx, p, args) {
  const result = await ctx.exec('git', args, { ...options(p), capture: true, echo: false, quiet: true, okCodes: [0, 1, 128] });
  return result.code === 0 ? result.stdout.trim() : '';
}

export default [
  git({
    type: 'git.clone',
    label: 'Git: Klonen',
    icon: 'downloadcloud',
    description: 'Klont ein Repository in einen Ordner.',
    fields: [
      text('url', 'Repository-URL', { required: true, placeholder: 'https://github.com/benutzer/projekt.git' }),
      filePath('dest', 'Zielordner', { placeholder: 'Name des Repositorys' }),
      text('branch', 'Branch oder Tag'),
      number('depth', 'Verlaufstiefe', { group: 'advanced', placeholder: 'vollständig', hint: '1 holt nur den neuesten Stand – schneller bei grossen Repositorys.' }),
      check('clean', 'Zielordner vorher löschen'),
    ],
    summary: '{url} {dest}',
    async run(ctx, p) {
      if (p.clean && p.dest) await fs.rm(ctx.path(p.dest), { recursive: true, force: true });
      const args = ['clone'];
      if (p.branch) args.push('--branch', p.branch);
      if (p.depth) args.push('--depth', String(p.depth));
      args.push(p.url);
      if (p.dest) args.push(ctx.path(p.dest));
      await ctx.exec('git', args, { timeoutSec: p.timeout });
    },
  }),
  git({
    type: 'git.pull',
    label: 'Git: Aktualisieren',
    icon: 'download',
    description: 'Holt den neuesten Stand vom Server (git pull).',
    fields: [repo, check('rebase', 'Eigene Commits neu aufsetzen (--rebase)')],
    summary: '{repo}',
    run: (ctx, p) => ctx.exec('git', ['pull', ...(p.rebase ? ['--rebase'] : [])], options(p)),
  }),
  git({
    type: 'git.checkout',
    label: 'Git: Auschecken',
    icon: 'branch',
    description: 'Wechselt auf einen Branch, Tag oder Commit.',
    fields: [repo, text('ref', 'Branch, Tag oder Commit', { required: true }), check('create', 'Neuen Branch anlegen')],
    summary: '{ref}',
    run: (ctx, p) => ctx.exec('git', ['checkout', ...(p.create ? ['-B'] : []), p.ref], options(p)),
  }),
  git({
    type: 'git.commit',
    label: 'Git: Commit',
    icon: 'commit',
    description: 'Nimmt Änderungen auf und erstellt einen Commit.',
    fields: [
      repo,
      area('message', 'Nachricht', { required: true }),
      text('paths', 'Dateien', { placeholder: 'alle Änderungen', hint: 'Leer = alle Änderungen im Repository.' }),
      check('allowEmpty', 'Kein Fehler, wenn es nichts zu committen gibt', { default: true }),
    ],
    summary: '{message}',
    async run(ctx, p) {
      const paths = splitArgs(p.paths);
      await ctx.exec('git', paths.length ? ['add', '--', ...paths] : ['add', '-A'], options(p));
      const staged = await ctx.exec('git', ['diff', '--cached', '--quiet'], { ...options(p), okCodes: [0, 1], echo: false, quiet: true });
      if (staged.code === 0) {
        if (!p.allowEmpty) ctx.fail('Es gibt keine Änderungen zu committen.');
        ctx.log('Keine Änderungen – Commit übersprungen.');
        return;
      }
      await ctx.exec('git', ['commit', '-m', p.message], options(p));
    },
  }),
  git({
    type: 'git.tag',
    label: 'Git: Tag setzen',
    icon: 'tag',
    description: 'Markiert den aktuellen Commit mit einem Tag.',
    fields: [
      repo,
      text('name', 'Tag-Name', { required: true, placeholder: 'v${VERSION}' }),
      text('message', 'Beschreibung', { hint: 'Mit Beschreibung entsteht ein annotierter Tag.' }),
      check('force', 'Vorhandenen Tag ersetzen'),
    ],
    summary: '{name}',
    run(ctx, p) {
      const args = ['tag'];
      if (p.force) args.push('--force');
      if (p.message) args.push('-a', '-m', p.message);
      return ctx.exec('git', [...args, p.name], options(p));
    },
  }),
  git({
    type: 'git.push',
    label: 'Git: Hochladen',
    icon: 'upload',
    description: 'Überträgt Commits und optional Tags zum Server (git push).',
    fields: [
      repo,
      text('remote', 'Remote', { default: 'origin' }),
      text('ref', 'Branch', { placeholder: 'aktueller Branch' }),
      check('tags', 'Tags mitsenden'),
      check('setUpstream', 'Als Upstream festlegen (-u)'),
    ],
    summary: '{remote} {ref}',
    run(ctx, p) {
      const args = ['push'];
      if (p.setUpstream) args.push('-u');
      if (p.tags) args.push('--tags');
      args.push(p.remote || 'origin');
      if (p.ref) args.push(p.ref);
      else if (p.setUpstream) args.push('HEAD');
      return ctx.exec('git', args, options(p));
    },
  }),
  git({
    type: 'git.info',
    label: 'Git: Stand auslesen',
    icon: 'info',
    description: 'Liest Branch, Commit und letzten Tag in Variablen: …BRANCH, …COMMIT, …COMMIT_SHORT, …TAG und …DIRTY (true/false).',
    fields: [repo, text('prefix', 'Präfix der Variablen', { default: 'GIT_' })],
    provides: ['{prefix}BRANCH', '{prefix}COMMIT', '{prefix}COMMIT_SHORT', '{prefix}TAG', '{prefix}DIRTY'],
    summary: '{prefix}…',
    async run(ctx, p) {
      const prefix = p.prefix ?? 'GIT_';
      const commit = await query(ctx, p, ['rev-parse', 'HEAD']);
      if (!commit) ctx.fail('Kein Git-Repository mit mindestens einem Commit gefunden.');
      const values = {
        BRANCH: await query(ctx, p, ['rev-parse', '--abbrev-ref', 'HEAD']),
        COMMIT: commit,
        COMMIT_SHORT: await query(ctx, p, ['rev-parse', '--short', 'HEAD']),
        TAG: await query(ctx, p, ['describe', '--tags', '--abbrev=0']),
        DIRTY: (await query(ctx, p, ['status', '--porcelain'])) ? 'true' : 'false',
      };
      for (const [name, value] of Object.entries(values)) {
        ctx.vars.set(prefix + name, value);
        ctx.log(`${prefix}${name} = ${value}`);
      }
    },
  }),
];
