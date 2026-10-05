import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextAtomic, readText } from '../plugins/lib/dotstore.js';
import {
  normalizeDay,
  yesterdayDay,
  dayOf,
  entriesForDay,
  drainedForDay,
  linesForDay,
  kindCounts,
  aliveDays,
  buildRollup,
} from '../plugins/lib/dotrollup.js';

const at = (hour, day = '2026-10-04') => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dotrollup-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path: (name) => join(dir, name) };
}

test('writeTextAtomic round-trips and replaces wholesale', async (t) => {
  const sb = await sandbox(t);
  const p = sb.path('page.md');
  await writeTextAtomic(p, '# one\n');
  await writeTextAtomic(p, '# two\n');
  assert.equal(await readFile(p, 'utf8'), '# two\n');
  assert.equal(await readText(sb.path('absent.md'), 'fallback'), 'fallback');
});

test('normalizeDay accepts YYYY-MM-DD and rejects junk', () => {
  assert.equal(normalizeDay('2026-10-04'), '2026-10-04');
  assert.equal(normalizeDay('2026-10-4'), null);
  assert.equal(normalizeDay('tomorrow'), null);
  assert.equal(normalizeDay(undefined), null);
});

test('yesterdayDay is the previous UTC day', () => {
  assert.equal(yesterdayDay(Date.parse('2026-10-05T06:00:00.000Z')), '2026-10-04');
  assert.equal(yesterdayDay(Date.parse('2026-01-01T00:30:00.000Z')), '2025-12-31');
});

test('dayOf parses ISO stamps and log-line prefixes', () => {
  assert.equal(dayOf('2026-10-04T21:02:03.004Z'), '2026-10-04');
  assert.equal(dayOf('2026-10-04T21:02:03Z round 3: did things'), '2026-10-04');
  assert.equal(dayOf('no stamp here'), null);
  assert.equal(dayOf(42), null);
});

test('entriesForDay and drainedForDay split by their own stamps', () => {
  const journal = [{ at: at(3), kind: 'a' }, { at: at(4, '2026-10-05'), kind: 'b' }, { kind: 'nostamp' }];
  assert.deepEqual(entriesForDay(journal, '2026-10-04'), [journal[0]]);
  const drained = [
    { at: at(1), drainedAt: at(23), kind: 'x' },
    { at: at(2), drainedAt: at(2, '2026-10-05'), kind: 'y' },
    { at: at(5), kind: 'z' }, // no drainedAt: falls back to at
  ];
  assert.deepEqual(drainedForDay(drained, '2026-10-04').map((e) => e.kind), ['x', 'z']);
});

test('linesForDay picks stamped log lines only', () => {
  const text = `2026-10-04T20:24:32Z round 1: swept\ncontinued line without stamp\n2026-10-05T00:01:00Z tick\n`;
  assert.deepEqual(linesForDay(text, '2026-10-04'), ['2026-10-04T20:24:32Z round 1: swept']);
});

test('kindCounts groups and orders by count desc, then name', () => {
  const counts = kindCounts([{ kind: 'b' }, { kind: 'a' }, { kind: 'b' }, {}, { kind: 'a' }, { kind: 'a' }]);
  assert.deepEqual(counts, [
    ['a', 3],
    ['b', 2],
    ['(untyped)', 1],
  ]);
});

test('aliveDays spans first evidence through yesterday, gaps included', () => {
  const out = aliveDays(
    { journal: [{ at: at(5, '2026-10-01') }], heartbeat: '2026-10-03T00:00:01Z tick (beat)\n' },
    '2026-10-04',
  );
  assert.deepEqual(out, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(aliveDays({}), []);
});

test('buildRollup renders every section from a mixed fixture day', () => {
  const day = '2026-10-04';
  const md = buildRollup({
    date: day,
    generatedAt: '2026-10-05T00:00:00.000Z',
    sources: {
      journal: [
        { at: at(0), kind: 'boot', plugin: 'dot-core' },
        { at: at(1), kind: 'schedule-fired', name: 'rollup', fired: 1, via: 'beat' },
        { at: at(2), kind: 'schedule-fired', name: 'rollup', fired: 2, via: 'beat' },
        { at: at(3), kind: 'event-route-conflict', path: '/dot/inbox', error: 'duplicate route' },
        { at: at(4, '2026-10-05'), kind: 'boot', plugin: 'next-day' },
      ],
      inboxDone: [
        { at: at(1), drainedAt: at(6), kind: 'schedule', name: 'rollup', task: 'write yesterday rollup' },
        { at: at(2), drainedAt: at(6), kind: 'self', from: 'dot', message: 'ping | with a pipe' },
      ],
      rounds: `2026-10-04T20:24:32Z round 1: inbox swept\n2026-10-04T20:25:27Z round 2: zero-work round\n`,
      heartbeat: `${at(0)} tick (boot) schedules armed\n${at(5)} tick error: schedule.json unwritable\n${at(23)} tick (beat)\n`,
    },
  });
  assert.match(md, /^# dot status — 2026-10-04/m);
  assert.match(md, /3 heartbeats · first 2026-10-04T00:00:00 · last 2026-10-04T23:00:00/);
  assert.match(md, /journal events: 4 · inbox items drained: 2 · goal rounds: 2/);
  assert.match(md, /## rounds[\s\S]*round 2: zero-work round/);
  assert.match(md, /\| schedule-fired \| 2 \|/);
  assert.match(md, /## schedules fired[\s\S]*rollup — 2×/);
  assert.match(md, /## inbox drained[\s\S]*write yesterday rollup/);
  assert.match(md, /route conflict: `\/dot\/inbox` — duplicate route/);
  assert.match(md, /restart: dot-core booted/);
  assert.match(md, /heartbeat: 2026-10-04T05:00:00.000Z tick error: schedule\.json unwritable/);
  assert.doesNotMatch(md, /next-day/);
  assert.match(md, /ping \\| with a pipe/); // table-injection chars neutralized
  assert.match(md, /_generated 2026-10-05T00:00:00\.000Z/);
});

test('buildRollup: an empty day degrades to honest (none)s', () => {
  const md = buildRollup({ date: '2026-10-04', sources: {}, generatedAt: 'G' });
  assert.match(md, /no heartbeats recorded/);
  assert.match(md, /## journal by kind\n\n\(none\)/);
  assert.match(md, /## anomalies\n\n\(none\)/);
});
