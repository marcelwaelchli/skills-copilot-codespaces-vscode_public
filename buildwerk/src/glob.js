// Minimal glob: `*`, `?` and `**`. Unlike shell globs, `*` also matches dotfiles,
// because a build step that copies «everything» should not silently skip them.

import fs from 'node:fs/promises';
import path from 'node:path';

export function hasMagic(pattern) {
  return /[*?]/.test(pattern);
}

function segmentRegex(segment) {
  const source = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

/** Splits a pattern into its wildcard-free leading directory and the remaining segments. */
export function splitPattern(pattern, cwd) {
  const absolute = path.resolve(cwd, pattern);
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let base = root;
  while (segments.length && !hasMagic(segments[0])) base = path.join(base, segments.shift());
  return { base, segments };
}

async function expand(dir, segments, results) {
  if (segments.length === 0) {
    results.add(dir);
    return;
  }
  const [segment, ...rest] = segments;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // not a directory, or unreadable
  }
  if (segment === '**') {
    if (rest.length === 0) {
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        results.add(full);
        if (entry.isDirectory()) await expand(full, segments, results);
      }
      return;
    }
    await expand(dir, rest, results);
    for (const entry of entries) {
      if (entry.isDirectory()) await expand(path.join(dir, entry.name), segments, results);
    }
    return;
  }
  const regex = segmentRegex(segment);
  for (const entry of entries) {
    if (!regex.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (rest.length === 0) results.add(full);
    else if (entry.isDirectory()) await expand(full, rest, results);
  }
}

/**
 * Resolves one pattern to absolute paths, sorted. A pattern without wildcards
 * yields the path itself when it exists.
 */
export async function glob(pattern, cwd) {
  const { base, segments } = splitPattern(pattern, cwd);
  const results = new Set();
  if (segments.length === 0) {
    try {
      await fs.access(base);
      results.add(base);
    } catch {
      // no match
    }
  } else {
    await expand(base, segments, results);
  }
  return [...results].sort();
}

/** Several patterns, one per line or separated by `;`. Lines starting with `!` exclude. */
export async function globAll(patterns, cwd) {
  const list = String(patterns).split(/[\n;]/).map((p) => p.trim()).filter(Boolean);
  const included = new Set();
  const excluded = new Set();
  for (const pattern of list) {
    const negated = pattern.startsWith('!');
    for (const match of await glob(negated ? pattern.slice(1) : pattern, cwd)) {
      (negated ? excluded : included).add(match);
    }
  }
  return [...included].filter((file) => !excluded.has(file)).sort();
}
