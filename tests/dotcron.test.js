import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../plugins/dot-scheduler.js';

test('normalize accepts a valid every-schedule (>= 5s)', () => {
  const item = { id: 'a1', kind: 'every', everySeconds: 60, task: 'ping', name: 'p' };
  assert.equal(normalize(item), item);
});

test('normalize rejects every-schedules under 5 seconds or malformed', () => {
  assert.equal(normalize({ kind: 'every', everySeconds: 4 }), null);
  assert.equal(normalize({ kind: 'every', everySeconds: '60' }), null);
  assert.equal(normalize({ kind: 'every' }), null);
});

test('normalize accepts a valid at-schedule with parseable ISO time', () => {
  const item = { id: 'b2', kind: 'at', at: '2030-01-01T00:00:00.000Z', task: 'once', name: 'o' };
  assert.equal(normalize(item), item);
});

test('normalize rejects bad at-schedules and non-objects', () => {
  assert.equal(normalize({ kind: 'at', at: 'not-a-date' }), null);
  assert.equal(normalize({ kind: 'at' }), null);
  assert.equal(normalize(null), null);
  assert.equal(normalize('every'), null);
  assert.equal(normalize({ kind: 'weekly', everySeconds: 3600 }), null);
});
