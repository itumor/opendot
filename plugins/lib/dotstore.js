/**
 * dotstore — file-system primitives shared by the dot plugins.
 *
 * Deliberately dependency-free: preset file rows are imported straight from
 * this repository, and bare package specifiers would not resolve from here.
 * Node builtins (`node:*`) are the only allowed imports.
 *
 * Durability rules the whole dot stack follows:
 *  - every mutation is atomic (write tmp + rename) or an append;
 *  - a corrupt or absent file degrades to a documented fallback, never to a
 *    crash of the agent that owns the dot;
 *  - all timestamps are ISO-8601 UTC.
 */
import { mkdir, open, readFile, writeFile, rename, appendFile } from 'node:fs/promises';

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/** Read a JSON file; return `fallback` when absent or unparsable. */
export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** JSON.stringify-tolerant atomic write: tmp file in the same dir + rename. */
export async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

/** Plain-text atomic write (status rollups, generated markdown): tmp + rename. */
export async function writeTextAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  await writeFile(tmp, String(text), 'utf8');
  await rename(tmp, path);
}

/** Append one line (no newline handling inside `line`): journals and logs. */
export async function appendLine(path, line) {
  await appendFile(path, line + '\n', 'utf8');
}

/** Read a whole text file; return `fallback` when absent or unreadable. */
export async function readText(path, fallback) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * Read a `.jsonl` journal into objects. Tolerates blank space and skips
 * malformed lines rather than failing the whole read — a journal with one
 * torn tail line (killed mid-write) must stay readable.
 */
export async function readJsonLines(path) {
  const text = await readText(path, '');
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* torn line: skip */
    }
  }
  return out;
}

/**
 * Read only the tail of a (potentially huge) file: opens the file, seeks to
 * `size - maxBytes`, and decodes the rest. Absent/unreadable files degrade to
 * `fallback`. Used by status surfaces that must never load a whole journal.
 */
export async function readTail(path, maxBytes, fallback = '') {
  let handle = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.max(0, Math.min(size, maxBytes));
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return fallback;
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
  }
}

export function nowIso() {
  return new Date().toISOString();
}
