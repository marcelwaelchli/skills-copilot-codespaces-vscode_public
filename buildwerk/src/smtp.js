// A small SMTP client: enough to send a build notification with attachments
// through a normal mail server (STARTTLS or TLS, AUTH PLAIN or LOGIN).

import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { CancelledError, OperationError } from './errors.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const ASCII = /^[\x20-\x7e]*$/;
const ADDRESS = /^[^\s@<>"',;:\\()[\]]+@[^\s@<>"',;:\\()[\]]+$/;

// ---------------------------------------------------------------- addresses

/**
 * Parses a list such as `Anna <a@x.ch>, b@y.ch; "Muster, Max" <m@z.ch>`.
 * Separators are comma, semicolon and line break, except inside quotes.
 * @returns {{name: string, address: string}[]}
 */
export function parseAddresses(text) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (const char of String(text ?? '')) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === ',' || char === ';' || char === '\n')) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*)<([^<>]*)>$/.exec(part);
      const address = (match ? match[2] : part).trim();
      const name = match ? match[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
      if (!ADDRESS.test(address) || !ASCII.test(address)) throw new OperationError(`«${part}» ist keine gültige E-Mail-Adresse.`);
      // Line breaks cannot occur here (they are separators), so a name can never smuggle in a header.
      return { name, address };
    });
}

// ------------------------------------------------------------------ message

const base64Lines = (buffer) => buffer.toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');

/** Header text with non-ASCII characters as RFC 2047 encoded words, folded into short lines. */
function encodeHeaderText(text) {
  if (ASCII.test(text)) return text;
  // 39 bytes become 52 base64 characters: with the wrapper and a header name the line stays under 78.
  const words = [];
  let chunk = '';
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > 39) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}

function formatAddress({ name, address }) {
  if (!name) return address;
  const shown = ASCII.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeHeaderText(name);
  return `${shown} <${address}>`;
}

const oneLine = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * Builds the complete message (headers and body) with CRLF line endings.
 * @param {object} mail
 * @param {{name: string, address: string}} mail.from
 * @param {{name: string, address: string}[]} mail.to
 * @param {{name: string, address: string}[]} [mail.cc]
 * @param {string} mail.subject
 * @param {string} [mail.body]
 * @param {{name: string, content: Buffer}[]} [mail.attachments]
 */
export function buildMessage({ from, to, cc = [], subject, body = '', attachments = [], date = new Date() }) {
  const domain = from.address.split('@')[1];
  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${to.map(formatAddress).join(',\r\n ')}`,
    ...(cc.length ? [`Cc: ${cc.map(formatAddress).join(',\r\n ')}`] : []),
    `Subject: ${encodeHeaderText(oneLine(subject))}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  const text = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(body.replace(/\r?\n/g, '\r\n')))];
  if (attachments.length === 0) return [...headers, ...text].join('\r\n') + '\r\n';

  const boundary = `buildwerk-${randomBytes(12).toString('hex')}`;
  const parts = [`--${boundary}`, ...text];
  for (const attachment of attachments) {
    // Plain name for old mail programs, RFC 2231 form for names with umlauts.
    const plain = attachment.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    parts.push(
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="${plain}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${plain}";\r\n filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      '',
      base64Lines(attachment.content),
    );
  }
  parts.push(`--${boundary}--`);
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ session

/** Reads SMTP replies (possibly several lines) off a socket, one reply per `read()`. */
class Session {
  #socket;
  #buffer = '';
  #lines = [];
  #replies = [];
  #waiting = null;
  #failure = null;

  constructor(socket) {
    this.attach(socket);
  }

  attach(socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', this.#onData);
    socket.on('error', this.#onEnd);
    socket.on('close', this.#onEnd);
  }

  detach() {
    this.#socket.off('data', this.#onData);
    this.#socket.off('error', this.#onEnd);
    this.#socket.off('close', this.#onEnd);
  }

  #onData = (chunk) => {
    this.#buffer += chunk;
    let end;
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(end + 1);
      this.#lines.push(line);
      // `250-...` continues, `250 ...` ends the reply.
      if (/^\d{3}( |$)/.test(line)) {
        this.#replies.push({ code: Number(line.slice(0, 3)), lines: this.#lines.map((l) => l.slice(4)) });
        this.#lines = [];
      }
    }
    this.#deliver();
  };

  #onEnd = (error) => {
    this.#failure ||= new OperationError(`Die Verbindung zum Mailserver wurde unterbrochen${error?.message ? `: ${error.message}` : '.'}`);
    this.#deliver();
  };

  #deliver() {
    if (!this.#waiting) return;
    if (this.#replies.length) this.#waiting.resolve(this.#replies.shift());
    else if (this.#failure) this.#waiting.reject(this.#failure);
    else return;
    this.#waiting = null;
  }

  fail(error) {
    this.#failure = error;
    this.#deliver();
  }

  read() {
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.#deliver();
    });
  }

  command(line) {
    this.#socket.write(`${line}\r\n`);
    return this.read();
  }
}

function expect(reply, codes, what) {
  if (![codes].flat().includes(reply.code)) {
    throw new OperationError(`${what}: Der Mailserver antwortet «${reply.code} ${reply.lines.join(' ')}».`);
  }
  return reply;
}

function connect(options, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect(options) : net.connect(options);
    socket.once(secure ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', (error) => reject(new OperationError(`Keine Verbindung zum Mailserver ${options.host}:${options.port}: ${error.message}`)));
  });
}

/**
 * Sends one message.
 * @param {object} options
 * @param {'starttls'|'tls'|'none'} options.security
 * @param {string} options.from envelope sender address
 * @param {string[]} options.recipients envelope recipients (To, Cc and Bcc together)
 * @param {string} options.message complete message as built by buildMessage
 * @param {boolean} [options.rejectUnauthorized] set to false to accept a self-signed certificate
 */
export async function sendMail({ host, port, security = 'starttls', user, password = '', from, recipients, message, signal, timeoutMs = 60_000, rejectUnauthorized = true, log = () => {} }) {
  if (user && security === 'none' && !LOOPBACK.has(host)) {
    throw new OperationError('Benutzername und Passwort werden nicht unverschlüsselt übertragen. Wähle STARTTLS oder TLS.');
  }
  if (signal?.aborted) throw new CancelledError();
  const servername = net.isIP(host) ? undefined : host;
  let socket = await connect({ host, port, servername, rejectUnauthorized }, security === 'tls');
  const session = new Session(socket);

  // One place for everything that can cut the conversation short.
  const guard = (active) => {
    active.setTimeout(timeoutMs, () => {
      session.fail(new OperationError(`Der Mailserver antwortet nicht (Zeitlimit ${Math.round(timeoutMs / 1000)} s).`));
      active.destroy();
    });
  };
  const onAbort = () => {
    session.fail(new CancelledError());
    socket.destroy();
  };
  guard(socket);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const clientName = /^[A-Za-z0-9.-]+$/.test(os.hostname()) ? os.hostname() : 'localhost';
    const hello = async () => {
      const reply = expect(await session.command(`EHLO ${clientName}`), 250, 'Begrüssung fehlgeschlagen');
      return new Map(reply.lines.slice(1).map((line) => [line.split(' ')[0].toUpperCase(), line.split(' ').slice(1).join(' ').toUpperCase()]));
    };

    expect(await session.read(), 220, 'Der Mailserver nimmt keine Verbindung an');
    let features = await hello();
    log(`Verbunden mit ${host}:${port}.`);

    if (security === 'starttls') {
      if (!features.has('STARTTLS')) throw new OperationError('Der Mailserver bietet kein STARTTLS an. Für Port 465 ist «TLS von Anfang an» die richtige Einstellung.');
      expect(await session.command('STARTTLS'), 220, 'STARTTLS wurde abgelehnt');
      session.detach();
      socket = await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket, servername, rejectUnauthorized });
        upgraded.once('secureConnect', () => resolve(upgraded));
        upgraded.once('error', (error) => reject(new OperationError(`Die sichere Verbindung zum Mailserver kam nicht zustande: ${error.message}`)));
      });
      session.attach(socket);
      guard(socket);
      features = await hello();
    }
    if (security !== 'none') log(`Verbindung ist verschlüsselt (${socket.getProtocol()}).`);

    if (user) {
      const methods = (features.get('AUTH') || '').split(/\s+/);
      const encode = (text) => Buffer.from(text).toString('base64');
      if (methods.includes('PLAIN')) {
        expect(await session.command(`AUTH PLAIN ${encode(`\0${user}\0${password}`)}`), 235, 'Anmeldung fehlgeschlagen');
      } else if (methods.includes('LOGIN')) {
        expect(await session.command('AUTH LOGIN'), 334, 'Anmeldung fehlgeschlagen');
        expect(await session.command(encode(user)), 334, 'Anmeldung fehlgeschlagen');
        expect(await session.command(encode(password)), 235, 'Anmeldung fehlgeschlagen');
      } else {
        throw new OperationError('Der Mailserver bietet keine unterstützte Anmeldung an (PLAIN oder LOGIN).');
      }
      log(`Angemeldet als ${user}.`);
    }

    expect(await session.command(`MAIL FROM:<${from}>`), 250, 'Absender wurde abgelehnt');
    for (const recipient of recipients) {
      expect(await session.command(`RCPT TO:<${recipient}>`), [250, 251], `Empfänger ${recipient} wurde abgelehnt`);
    }
    expect(await session.command('DATA'), 354, 'Der Mailserver nimmt die Nachricht nicht an');
    // A line consisting of a single dot ends the message, so leading dots are doubled.
    expect(await session.command(`${message.replace(/^\./gm, '..').replace(/\r\n$/, '')}\r\n.`), 250, 'Die Nachricht wurde abgelehnt');
    await session.command('QUIT').catch(() => {});
  } catch (error) {
    // A failed TLS upgrade surfaces here as a plain error from the socket.
    throw error instanceof OperationError || error instanceof CancelledError ? error : new OperationError(`E-Mail-Versand fehlgeschlagen: ${error.message}`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    socket.destroy();
  }
}
