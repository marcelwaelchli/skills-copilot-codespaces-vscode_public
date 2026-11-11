// «E-Mail senden»: message building and a real SMTP conversation against a
// small server that runs inside the test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { after, before, test } from 'node:test';
import { buildMessage, parseAddresses, sendMail } from '../src/smtp.js';
import { onPath, op, runMacro, tempDir } from './helpers.js';

let dir;
let certificate = null;

before(async () => {
  dir = await tempDir();
  await fs.writeFile(path.join(dir, 'protokoll.txt'), 'alles gut\n');
  await fs.writeFile(path.join(dir, 'Übersicht.txt'), 'äöü\n');
  // A throw-away certificate for the TLS tests; without openssl they are skipped.
  if (!onPath('openssl')) return;
  try {
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost'], { stdio: 'pipe' });
    certificate = { key: await fs.readFile(key), cert: await fs.readFile(cert) };
  } catch {
    certificate = null;
  }
});
after(() => fs.rm(dir, { recursive: true, force: true }));

/**
 * A minimal SMTP server that records what it is told.
 * @param {object} [options]
 * @param {'plain'|'starttls'|'tls'} [options.mode]
 * @param {string[]} [options.authMethods]
 * @param {string} [options.rejectRecipient] address to answer with 550
 * @param {boolean} [options.silent] accept connections but never say anything
 */
async function startSmtp({ mode = 'plain', authMethods = ['PLAIN', 'LOGIN'], rejectRecipient, silent = false } = {}) {
  const seen = { commands: [], messages: [], credentials: null, encrypted: false };

  function serve(socket, { greet, encrypted }) {
    let buffer = '';
    let receiving = false;
    let data = '';
    let login = null; // collects the two answers of AUTH LOGIN
    const send = (line) => socket.write(`${line}\r\n`);
    const decode = (text) => Buffer.from(text, 'base64').toString();
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    if (silent) return;
    if (greet) send('220 test.local ESMTP');

    const onLine = (line) => {
      if (receiving) {
        if (line === '.') {
          receiving = false;
          seen.messages.push(data);
          data = '';
          return send('250 OK');
        }
        data += `${line.startsWith('.') ? line.slice(1) : line}\r\n`; // undo dot-stuffing
        return;
      }
      if (login) {
        login.push(decode(line));
        if (login.length === 1) return send('334 UGFzc3dvcmQ6');
        seen.credentials = { user: login[0], password: login[1] };
        login = null;
        return send(seen.credentials.password === 'geheim' ? '235 OK' : '535 Falsche Anmeldedaten');
      }
      const [verb, ...rest] = line.split(' ');
      seen.commands.push(verb.toUpperCase() === 'AUTH' ? `AUTH ${rest[0]}` : line);
      switch (verb.toUpperCase()) {
        case 'EHLO':
          send('250-test.local');
          if (mode === 'starttls' && !encrypted) send('250-STARTTLS');
          if (authMethods.length) send(`250-AUTH ${authMethods.join(' ')}`);
          return send('250 SIZE 30000000');
        case 'STARTTLS': {
          send('220 Los');
          socket.removeAllListeners('data');
          const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(certificate) });
          seen.encrypted = true;
          return serve(secure, { greet: false, encrypted: true });
        }
        case 'AUTH':
          if (rest[0] === 'LOGIN') {
            login = [];
            return send('334 VXNlcm5hbWU6');
          } else {
            const [, user, password] = decode(rest[1]).split('\0');
            seen.credentials = { user, password };
            return send(password === 'geheim' ? '235 OK' : '535 Falsche Anmeldedaten');
          }
        case 'MAIL':
          return send('250 OK');
        case 'RCPT':
          return send(rejectRecipient && line.includes(rejectRecipient) ? '550 Unbekannter Empfänger' : '250 OK');
        case 'DATA':
          receiving = true;
          return send('354 Los');
        case 'QUIT':
          send('221 Tschüss');
          return socket.end();
        default:
          return send('500 Unbekannt');
      }
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        onLine(line);
      }
    });
  }

  const server =
    mode === 'tls'
      ? tls.createServer(certificate, (socket) => ((seen.encrypted = true), serve(socket, { greet: true, encrypted: true })))
      : net.createServer((socket) => serve(socket, { greet: true, encrypted: false }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Splits a received message into headers and decoded parts. */
function readMessage(raw) {
  const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
  const [head, ...rest] = unfolded.split('\r\n\r\n');
  const headers = Object.fromEntries(head.split('\r\n').map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
  // Whitespace between two encoded words is not part of the text; whitespace before plain text is.
  const decodeWords = (text) => text.replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, word) => Buffer.from(word, 'base64').toString());
  const boundary = /boundary="([^"]+)"/.exec(headers['content-type'] || '')?.[1];
  if (!boundary) return { headers, decodeWords, text: Buffer.from(rest.join(''), 'base64').toString(), attachments: [] };
  const parts = raw.split(`--${boundary}`).slice(1, -1).map((part) => {
    const [partHead, body] = part.replace(/^\r\n/, '').split('\r\n\r\n');
    return { head: partHead, content: Buffer.from(body, 'base64') };
  });
  return {
    headers,
    decodeWords,
    text: parts[0].content.toString(),
    attachments: parts.slice(1).map((part) => ({ name: decodeURIComponent(/filename\*=UTF-8''(\S+)/.exec(part.head)[1]), content: part.content.toString() })),
  };
}

const mail = (port, props = {}) =>
  op('net.mail', { host: '127.0.0.1', port: String(port), security: 'none', from: 'Build <build@example.com>', to: 'anna@example.com', subject: 'Test', body: 'Hallo', ...props }, { id: 'mail' });
const run = (operations, variables = []) => runMacro(operations, { variables, options: { macroFile: path.join(dir, 'test.buildwerk.json') } });

test('parseAddresses: names, separators and quoted commas', () => {
  assert.deepEqual(parseAddresses('Anna <a@x.ch>, b@y.ch; "Muster, Max" <m@z.ch>\n  Jörg Müller <j@u.ch>  '), [
    { name: 'Anna', address: 'a@x.ch' },
    { name: '', address: 'b@y.ch' },
    { name: 'Muster, Max', address: 'm@z.ch' },
    { name: 'Jörg Müller', address: 'j@u.ch' },
  ]);
  assert.deepEqual(parseAddresses(''), []);
  for (const bad of ['kein-at-zeichen', 'a@b c@d', 'x <>', 'jörg@example.com']) assert.throws(() => parseAddresses(bad), /keine gültige E-Mail-Adresse/, bad);
});

test('buildMessage: headers are encoded, lines are short and end with CRLF', () => {
  const message = buildMessage({
    from: { name: 'Build', address: 'build@example.com' },
    to: [{ name: 'Jörg Müller', address: 'j@example.com' }, { name: '', address: 'b@example.com' }],
    cc: [{ name: 'Team', address: 'team@example.com' }],
    subject: 'Grüsse – Build 1.2.3 ist fertig und liegt zum Herunterladen bereit\r\nBcc: boese@example.com',
    body: 'Zeile eins\nÄöü',
    date: new Date(Date.UTC(2026, 2, 14, 9, 26, 53)),
  });
  assert.ok(!/[^\r]\n/.test(message), 'bare line feeds');
  assert.ok(message.split('\r\n').every((line) => line.length <= 78), 'long lines');
  const { headers, decodeWords, text } = readMessage(message);
  assert.equal(headers.from, '"Build" <build@example.com>');
  assert.equal(decodeWords(headers.to), 'Jörg Müller <j@example.com>, b@example.com');
  assert.equal(headers.cc, '"Team" <team@example.com>');
  // A line break in the subject must not start a new header.
  assert.equal(decodeWords(headers.subject), 'Grüsse – Build 1.2.3 ist fertig und liegt zum Herunterladen bereit Bcc: boese@example.com');
  assert.equal(headers.bcc, undefined);
  assert.equal(headers.date, 'Sat, 14 Mar 2026 09:26:53 +0000');
  assert.match(headers['message-id'], /^<[0-9a-f]+@example\.com>$/);
  assert.equal(text, 'Zeile eins\r\nÄöü');
});

test('sends a mail with login and attachments; BCC stays out of the headers', async () => {
  const server = await startSmtp();
  try {
    const { result, messages } = await run(
      [mail(server.port, { user: 'build', password: '${SMTP_PASSWORD}', to: 'Anna <anna@example.com>\nben@example.com', cc: 'chef@example.com', bcc: 'archiv@example.com', subject: 'Build ${V} fertig – Grüsse', body: 'Version ${V}\nist da.', attachments: 'protokoll.txt\nÜ*.txt' })],
      [{ name: 'V', value: '1.2.3' }, { name: 'SMTP_PASSWORD', value: 'geheim', secret: true }],
    );
    assert.equal(result.status, 'success', `${result.error}\n${messages.join('\n')}`);
    const { seen } = server;
    assert.deepEqual(seen.credentials, { user: 'build', password: 'geheim' });
    assert.deepEqual(seen.commands.filter((c) => /^(MAIL|RCPT)/.test(c)), [
      'MAIL FROM:<build@example.com>', 'RCPT TO:<anna@example.com>', 'RCPT TO:<ben@example.com>', 'RCPT TO:<chef@example.com>', 'RCPT TO:<archiv@example.com>',
    ]);
    assert.equal(seen.messages.length, 1);
    const received = readMessage(seen.messages[0]);
    assert.equal(received.decodeWords(received.headers.subject), 'Build 1.2.3 fertig – Grüsse');
    assert.equal(received.headers.to, '"Anna" <anna@example.com>, ben@example.com');
    assert.equal(received.headers.cc, 'chef@example.com');
    assert.ok(!seen.messages[0].includes('archiv@example.com'));
    assert.equal(received.text, 'Version 1.2.3\r\nist da.');
    assert.deepEqual(received.attachments, [{ name: 'protokoll.txt', content: 'alles gut\n' }, { name: 'Übersicht.txt', content: 'äöü\n' }]);
    assert.ok(messages.includes('E-Mail an 4 Adressen übergeben, mit 2 Anhängen.'));
    assert.ok(!JSON.stringify(messages).includes('geheim'));
  } finally {
    await server.close();
  }
});

test('falls back to AUTH LOGIN and reports a refused login', async () => {
  const server = await startSmtp({ authMethods: ['LOGIN'] });
  try {
    const good = await run([mail(server.port, { user: 'build', password: 'geheim' })]);
    assert.equal(good.result.status, 'success', good.result.error);
    assert.deepEqual(server.seen.credentials, { user: 'build', password: 'geheim' });
    const bad = await run([mail(server.port, { user: 'build', password: 'falsch' })]);
    assert.equal(bad.result.status, 'failed');
    assert.match(bad.result.error, /Anmeldung fehlgeschlagen: Der Mailserver antwortet «535 Falsche Anmeldedaten»/);
  } finally {
    await server.close();
  }
});

test('a refused recipient, missing attachments and bad addresses fail with a clear message', async () => {
  const server = await startSmtp({ rejectRecipient: 'weg@example.com' });
  try {
    const refused = await run([mail(server.port, { to: 'anna@example.com, weg@example.com' })]);
    assert.match(refused.result.error, /Empfänger weg@example\.com wurde abgelehnt: Der Mailserver antwortet «550 Unbekannter Empfänger»/);
    assert.equal(server.seen.messages.length, 0);
    const missing = await run([mail(server.port, { attachments: 'gibt-es-nicht-*.zip' })]);
    assert.match(missing.result.error, /Keine Anhänge gefunden/);
    const address = await run([mail(server.port, { to: 'ohne-at' })]);
    assert.match(address.result.error, /keine gültige E-Mail-Adresse/);
    const sender = await run([mail(server.port, { from: 'a@example.com, b@example.com' })]);
    assert.match(sender.result.error, /genau eine Adresse/);
  } finally {
    await server.close();
  }
});

test('a line starting with a dot survives the transfer', async () => {
  const server = await startSmtp();
  try {
    const message = 'Subject: Punkt\r\n\r\n.erste Zeile\r\n..zweite\r\nnormal\r\n';
    await sendMail({ host: '127.0.0.1', port: server.port, security: 'none', from: 'a@example.com', recipients: ['b@example.com'], message });
    assert.equal(server.seen.messages[0], message);
  } finally {
    await server.close();
  }
});

test('credentials are never sent unencrypted to a remote server', async () => {
  const { result } = await run([mail(25, { host: 'mail.example.invalid', user: 'build', password: 'geheim' })]);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /nicht unverschlüsselt übertragen/);
});

test('a server that says nothing runs into the time limit; stop() ends the wait', async () => {
  const server = await startSmtp({ silent: true });
  try {
    const slow = await run([mail(server.port, { timeout: '0.3' })]);
    assert.equal(slow.result.status, 'failed');
    assert.match(slow.result.error, /antwortet nicht/);
    const stopped = await runMacro([mail(server.port)], { onRun: (r) => r.on('event', (event) => event.type === 'op-start' && setTimeout(() => r.stop(), 100)) });
    assert.equal(stopped.result.status, 'cancelled');
    assert.ok(stopped.result.durationMs < 5000);
  } finally {
    await server.close();
  }
});

test('an unreachable server gives a clear error', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const { result } = await run([mail(port)]);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Keine Verbindung zum Mailserver 127\.0\.0\.1/);
});

test('STARTTLS: the connection is upgraded before login, and the certificate is checked', async (t) => {
  if (!certificate) return t.skip('openssl is not available to create a test certificate');
  const server = await startSmtp({ mode: 'starttls' });
  try {
    const trusted = await run([mail(server.port, { security: 'starttls', user: 'build', password: 'geheim', insecureTls: true })]);
    assert.equal(trusted.result.status, 'success', trusted.result.error);
    assert.equal(server.seen.encrypted, true);
    assert.deepEqual(server.seen.commands.slice(0, 4).map((c) => c.split(' ')[0]), ['EHLO', 'STARTTLS', 'EHLO', 'AUTH']);
    assert.ok(trusted.messages.some((line) => line.startsWith('Verbindung ist verschlüsselt (TLS')));

    // Without the override a self-signed certificate must be refused, before any credentials are sent.
    server.seen.credentials = null;
    const strict = await run([mail(server.port, { security: 'starttls', user: 'build', password: 'geheim' })]);
    assert.equal(strict.result.status, 'failed');
    assert.match(strict.result.error, /sichere Verbindung zum Mailserver kam nicht zustande/);
    assert.equal(server.seen.credentials, null);
  } finally {
    await server.close();
  }
});

test('STARTTLS is required when chosen: a server without it is refused', async () => {
  const server = await startSmtp({ mode: 'plain' });
  try {
    const { result } = await run([mail(server.port, { security: 'starttls' })]);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /bietet kein STARTTLS an/);
    assert.equal(server.seen.messages.length, 0);
  } finally {
    await server.close();
  }
});

test('TLS from the start (port 465 style)', async (t) => {
  if (!certificate) return t.skip('openssl is not available to create a test certificate');
  const server = await startSmtp({ mode: 'tls' });
  try {
    const sent = await run([mail(server.port, { security: 'tls', user: 'build', password: 'geheim', insecureTls: true })]);
    assert.equal(sent.result.status, 'success', sent.result.error);
    assert.equal(server.seen.messages.length, 1);
    const strict = await run([mail(server.port, { security: 'tls' })]);
    assert.equal(strict.result.status, 'failed');
    assert.match(strict.result.error, /Keine Verbindung zum Mailserver/);
  } finally {
    await server.close();
  }
});
