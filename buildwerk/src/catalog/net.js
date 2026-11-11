// HTTP requests, downloads and chat notifications.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { CancelledError, OperationError } from '../errors.js';
import { area, filePath, number, select, text, variable } from './fields.js';

const timeoutField = number('timeout', 'Zeitlimit in Sekunden', { group: 'advanced', default: '60' });

/** fetch with timeout, cancellation and readable error messages. */
async function request(ctx, url, init, timeoutSec) {
  const signals = [ctx.signal];
  if (timeoutSec) signals.push(AbortSignal.timeout(timeoutSec * 1000));
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (error) {
    if (ctx.signal.aborted) throw new CancelledError();
    if (error.name === 'TimeoutError') throw new OperationError(`Keine Antwort von ${url} innerhalb von ${timeoutSec} s.`);
    throw new OperationError(`Anfrage an ${url} fehlgeschlagen: ${error.cause?.message || error.message}`);
  }
}

function parseHeaders(textValue) {
  const headers = {};
  for (const line of String(textValue || '').split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return headers;
}

/** Accepts "200", "200-299" and comma-separated combinations. */
function statusMatches(status, expected) {
  return String(expected || '200-299').split(/[\s,;]+/).filter(Boolean).some((part) => {
    const [from, to = from] = part.split('-').map(Number);
    return status >= from && status <= to;
  });
}

const PAYLOADS = {
  slack: (message) => ({ text: message }),
  discord: (message) => ({ content: message }),
  teams: (message) => ({
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [{ type: 'TextBlock', text: message, wrap: true }],
        },
      },
    ],
  }),
  generic: (message) => ({ text: message, message }),
};

export default [
  {
    type: 'net.http',
    category: 'net',
    label: 'HTTP-Anfrage',
    icon: 'globe',
    description: 'Ruft eine URL auf – zum Beispiel um ein Deployment anzustossen oder einen Dienst zu prüfen.',
    fields: [
      select('method', 'Methode', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
      text('url', 'URL', { required: true, placeholder: 'https://example.com/api/deploy' }),
      area('headers', 'Header', { placeholder: 'Authorization: Bearer ${API_TOKEN}\nContent-Type: application/json' }),
      area('body', 'Inhalt', { showIf: { key: 'method', in: ['POST', 'PUT', 'PATCH', 'DELETE'] } }),
      text('expect', 'Erwarteter Status', { default: '200-299', hint: 'Einzelwerte oder Bereiche, z. B. 200,201 oder 200-299.' }),
      variable('responseVar', 'Antwort in Variable speichern'),
      timeoutField,
    ],
    summary: '{method} {url}',
    async run(ctx, p) {
      const init = { method: p.method, headers: parseHeaders(p.headers) };
      if (p.body) init.body = p.body;
      const response = await request(ctx, p.url, init, p.timeout);
      const body = await response.text();
      ctx.log(`${response.status} ${response.statusText}`);
      if (p.responseVar) ctx.vars.set(p.responseVar, body.trim());
      if (!statusMatches(response.status, p.expect)) {
        if (body) ctx.log(body.slice(0, 2000), 'stderr');
        throw new OperationError(`Unerwarteter Status ${response.status} (erwartet: ${p.expect || '200-299'}).`);
      }
    },
  },
  {
    type: 'net.download',
    category: 'net',
    label: 'Datei herunterladen',
    icon: 'download',
    description: 'Lädt eine Datei von einer URL herunter.',
    fields: [
      text('url', 'URL', { required: true }),
      filePath('dest', 'Zieldatei', { required: true }),
      area('headers', 'Header', { group: 'advanced', placeholder: 'Authorization: Bearer ${API_TOKEN}' }),
      timeoutField,
    ],
    summary: '{url} → {dest}',
    async run(ctx, p) {
      const response = await request(ctx, p.url, { headers: parseHeaders(p.headers) }, p.timeout);
      if (!response.ok) throw new OperationError(`Download fehlgeschlagen: ${response.status} ${response.statusText}`);
      const dest = ctx.path(p.dest);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
      } catch (error) {
        await fs.rm(dest, { force: true });
        if (ctx.signal.aborted) throw new CancelledError();
        throw new OperationError(`Download abgebrochen: ${error.message}`);
      }
      const size = (await fs.stat(dest)).size;
      ctx.log(`${(size / 1024).toFixed(1)} KB gespeichert: ${dest}`);
    },
  },
  {
    type: 'net.notify',
    category: 'net',
    label: 'Benachrichtigung senden',
    icon: 'bell',
    description: 'Schickt eine Nachricht über einen Webhook an Slack, Microsoft Teams, Discord oder einen eigenen Dienst.',
    fields: [
      select('service', 'Dienst', [
        { value: 'slack', label: 'Slack', short: 'Slack' },
        { value: 'teams', label: 'Microsoft Teams', short: 'Teams' },
        { value: 'discord', label: 'Discord', short: 'Discord' },
        { value: 'generic', label: 'Eigener Dienst (JSON)', short: 'Webhook' },
      ]),
      text('url', 'Webhook-URL', { required: true, placeholder: '${WEBHOOK_URL}', hint: 'Am besten als geheime Variable ablegen – die URL ist ein Passwort.' }),
      area('message', 'Nachricht', { required: true, placeholder: 'Build ${VERSION} ist fertig.' }),
      timeoutField,
    ],
    summary: '{service}: {message}',
    async run(ctx, p) {
      const payload = (PAYLOADS[p.service] || PAYLOADS.generic)(p.message);
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
      const response = await request(ctx, p.url, init, p.timeout);
      if (!response.ok) throw new OperationError(`Benachrichtigung abgelehnt: ${response.status} ${response.statusText}`);
      ctx.log('Benachrichtigung gesendet.');
    },
  },
];
