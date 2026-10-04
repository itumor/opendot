import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, readJsonLines, readText, readTail, ensureDir } from '../plugins/lib/dotstore.js';

/** tmpdir sandbox registered for cleanup via t.after (Node 20/22/24-safe). */
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dotstore-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path: (name) => join(dir, name) };
}

test('readJson returns fallback for absent file', async (t) => {
  const sb = await sandbox(t);
  assert.deepEqual(await readJson(sb.path('nope.json'), { a: 1 }), { a: 1 });
});

test('readJson returns fallback for corrupt file', async (t) => {
  const sb = await sandbox(t);
  await writeFile(sb.path('bad.json'), '{not json', 'utf8');
  assert.deepEqual(await readJson(sb.path('bad.json'), []), []);
});

test('writeJsonAtomic round-trips and is valid JSON', async (t) => {
  const sb = await sandbox(t);
  const value = { hello: 'world', n: 42 };
  await writeJsonAtomic(sb.path('kv.json'), value);
  assert.deepEqual(await readJson(sb.path('kv.json'), null), value);
});

test('readJsonLines skips torn lines and blanks', async (t) => {
  const sb = await sandbox(t);
  const p = sb.path('journal.jsonl');
  await writeFile(p, '{"a":1}\n\n  \n{torn-tail\n{"b":2}\n', 'utf8');
  assert.deepEqual(await readJsonLines(p), [{ a: 1 }, { b: 2 }]);
});

test('readTail returns exactly a sized suffix of a large file', async (t) => {
  const sb = await sandbox(t);
  const p = sb.path('big.log');
  const content = 'x'.repeat(4096) + '\n' + 'TAILMARKER:' + 'y'.repeat(128);
  await writeFile(p, content, 'utf8');
  const out = await readTail(p, 300, 'fallback');
  assert.equal(out.length, 300, 'returns at most maxBytes (ASCII here)');
  assert.ok(content.endsWith(out), 'result is a true suffix of the file');
  assert.ok(out.includes('TAILMARKER'), 'marker present in the window');
  const small = await readTail(p, 10, 'fallback');
  assert.equal(small, 'y'.repeat(10), 'small window reads only trailing bytes');
});

test('readTail degrades to fallback on absent file', async (t) => {
  const sb = await sandbox(t);
  assert.equal(await readTail(sb.path('absent.log'), 100, 'fb'), 'fb');
});

test('ensureDir creates nested paths idempotently', async (t) => {
  const sb = await sandbox(t);
  const nested = join(sb.dir, 'a', 'b', 'c');
  await ensureDir(nested);
  await ensureDir(nested);
  await appendFile(join(nested, 'f.txt'), 'ok', 'utf8');
  assert.equal(await readText(join(nested, 'f.txt'), null), 'ok');
});
