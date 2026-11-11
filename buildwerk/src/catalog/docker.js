// Container operations, built on the docker command line.

import { splitArgs } from '../process.js';
import { parseKeyValues, splitLines } from '../util.js';
import { area, check, filePath, opt, select, text, toolOp } from './fields.js';

const docker = (def) => toolOp({ category: 'docker', icon: 'box', ...def });

export default [
  docker({
    type: 'docker.build',
    label: 'Docker: Image bauen',
    description: 'Baut ein Container-Image aus einem Dockerfile.',
    fields: [
      text('tag', 'Image-Name', { required: true, placeholder: 'meinprojekt/app:${VERSION}' }),
      filePath('context', 'Build-Kontext', { default: '.' }),
      filePath('dockerfile', 'Dockerfile', { placeholder: 'Dockerfile im Kontext' }),
      area('buildArgs', 'Build-Argumente', { placeholder: 'NAME=Wert (eine pro Zeile)' }),
      text('platform', 'Plattform', { group: 'advanced', placeholder: 'linux/amd64' }),
      check('noCache', 'Ohne Cache bauen', { group: 'advanced' }),
    ],
    summary: '{tag}',
    command(p, ctx) {
      const args = ['build', '-t', p.tag];
      if (p.dockerfile) args.push('-f', ctx.path(p.dockerfile));
      for (const [name, value] of Object.entries(parseKeyValues(p.buildArgs))) args.push('--build-arg', `${name}=${value}`);
      opt(args, '--platform', p.platform);
      if (p.noCache) args.push('--no-cache');
      return { cmd: 'docker', args, tail: [ctx.path(p.context || '.')] };
    },
  }),
  docker({
    type: 'docker.push',
    label: 'Docker: Image hochladen',
    icon: 'upload',
    description: 'Lädt ein Image in eine Registry hoch.',
    fields: [text('image', 'Image-Name', { required: true })],
    summary: '{image}',
    command: (p) => ({ cmd: 'docker', args: ['push'], tail: [p.image] }),
  }),
  docker({
    type: 'docker.run',
    label: 'Docker: Container starten',
    description: 'Startet einen Container – etwa um in einer definierten Umgebung zu bauen oder zu testen.',
    fields: [
      text('image', 'Image', { required: true, placeholder: 'node:22' }),
      text('command', 'Befehl im Container'),
      area('volumes', 'Volumes', { placeholder: '${BASE_DIR}:/work (eines pro Zeile)' }),
      area('envVars', 'Umgebungsvariablen im Container', { placeholder: 'NAME=Wert (eine pro Zeile)' }),
      text('name', 'Container-Name', { group: 'advanced' }),
      check('rm', 'Container danach entfernen', { default: true }),
      check('detach', 'Im Hintergrund starten', { group: 'advanced' }),
    ],
    summary: '{image} {command}',
    command(p) {
      const args = ['run'];
      if (p.rm) args.push('--rm');
      if (p.detach) args.push('-d');
      opt(args, '--name', p.name);
      for (const volume of splitLines(p.volumes)) args.push('-v', volume);
      for (const [name, value] of Object.entries(parseKeyValues(p.envVars))) args.push('-e', `${name}=${value}`);
      return { cmd: 'docker', args, tail: [p.image, ...splitArgs(p.command)] };
    },
  }),
  docker({
    type: 'docker.compose',
    label: 'Docker Compose',
    icon: 'layers',
    description: 'Startet, stoppt oder baut die Dienste einer Compose-Datei.',
    fields: [
      select('command', 'Aktion', [
        { value: 'up', label: 'Starten (up)' },
        { value: 'down', label: 'Stoppen und entfernen (down)' },
        { value: 'build', label: 'Images bauen (build)' },
        { value: 'pull', label: 'Images holen (pull)' },
      ]),
      filePath('file', 'Compose-Datei', { placeholder: 'compose.yaml im Arbeitsverzeichnis' }),
      text('services', 'Dienste', { placeholder: 'alle' }),
      check('detach', 'Im Hintergrund starten', { default: true, showIf: { key: 'command', equals: 'up' } }),
      check('rebuild', 'Images vorher neu bauen', { showIf: { key: 'command', equals: 'up' } }),
    ],
    summary: '{command} {services}',
    command(p, ctx) {
      const args = ['compose'];
      if (p.file) args.push('-f', ctx.path(p.file));
      args.push(p.command);
      if (p.command === 'up' && p.detach) args.push('-d');
      if (p.command === 'up' && p.rebuild) args.push('--build');
      return { cmd: 'docker', args, tail: splitArgs(p.services) };
    },
  }),
];
