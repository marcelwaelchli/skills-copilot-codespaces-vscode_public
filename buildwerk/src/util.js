import fs from 'node:fs/promises';

/** Parses `NAME=value` lines; blank lines and lines starting with `#` are ignored. */
export function parseKeyValues(text) {
  const result = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return result;
}

export function splitLines(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

export async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

export async function isDirectory(file) {
  return Boolean((await statOrNull(file))?.isDirectory());
}
