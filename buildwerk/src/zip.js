// Small ZIP writer and reader (deflate, no ZIP64) so that packaging works the
// same on every platform without external tools.

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { OperationError } from './errors.js';

const LIMIT = 0xffffffff;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer);
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * @param {string} outFile
 * @param {{name: string, file?: string, directory?: boolean}[]} entries `name` uses forward slashes
 * @returns {Promise<number>} number of entries written
 */
export async function createZip(outFile, entries) {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const handle = await fsp.open(outFile, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const stat = entry.file ? await fsp.stat(entry.file) : { mtime: new Date(), mode: 0o755 };
      const isDir = entry.directory || (entry.file ? stat.isDirectory() : false);
      const name = Buffer.from(isDir && !entry.name.endsWith('/') ? entry.name + '/' : entry.name, 'utf8');
      const raw = isDir ? Buffer.alloc(0) : await fsp.readFile(entry.file);
      const deflated = raw.length ? zlib.deflateRawSync(raw, { level: 6 }) : raw;
      const useDeflate = deflated.length < raw.length;
      const data = useDeflate ? deflated : raw;
      if (raw.length >= LIMIT || offset + data.length >= LIMIT) {
        throw new OperationError('ZIP-Archive über 4 GB werden nicht unterstützt.');
      }
      const { time, date } = dosDateTime(stat.mtime);
      const crc = crc32(raw);
      const method = useDeflate ? 8 : 0;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      await handle.write(Buffer.concat([local, name, data]));

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE((3 << 8) | 20, 4); // made on Unix: keeps file modes
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(data.length, 20);
      header.writeUInt32LE(raw.length, 24);
      header.writeUInt16LE(name.length, 28);
      const mode = isDir ? 0o40755 : 0o100000 | (stat.mode & 0o777);
      header.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
      header.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([header, name]));
      offset += 30 + name.length + data.length;
    }
    if (central.length >= 0xffff) throw new OperationError('ZIP-Archive mit mehr als 65 534 Einträgen werden nicht unterstützt.');
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await handle.write(Buffer.concat([directory, end]));
  } finally {
    await handle.close();
  }
  return central.length;
}

/** Extracts an archive into `destDir`. Entries that would land outside of it are rejected. */
export async function extractZip(zipFile, destDir) {
  const buffer = await fsp.readFile(zipFile);
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new OperationError(`«${zipFile}» ist kein gültiges ZIP-Archiv.`);
  const count = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || position === LIMIT) throw new OperationError('ZIP64-Archive werden nicht unterstützt.');

  const root = path.resolve(destDir);
  await fsp.mkdir(root, { recursive: true });
  let extracted = 0;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(position) !== 0x02014b50) throw new OperationError('ZIP-Verzeichnis ist beschädigt.');
    const madeBy = buffer.readUInt16LE(position + 4) >> 8;
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const attributes = buffer.readUInt32LE(position + 38);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength);
    position += 46 + nameLength + extraLength + commentLength;

    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new OperationError(`Eintrag «${name}» liegt ausserhalb des Zielordners – Archiv abgelehnt.`);
    }
    if (name.endsWith('/')) {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new OperationError(`Eintrag «${name}» verwendet ein nicht unterstütztes Kompressionsverfahren (${method}).`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    const mode = (attributes >>> 16) & 0o777;
    if (madeBy === 3 && mode && process.platform !== 'win32') await fsp.chmod(target, mode);
    extracted++;
  }
  return extracted;
}

/** Collects every file below `dir` as zip entries, names relative to `prefix`. */
export async function collectEntries(dir, prefix = '') {
  const entries = [];
  for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      const nested = await collectEntries(full, name);
      if (nested.length === 0) entries.push({ name, directory: true });
      entries.push(...nested);
    } else if (item.isFile()) {
      entries.push({ name, file: full });
    }
  }
  return entries;
}
