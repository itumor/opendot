import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, matchPattern, decide, sanitize } from '../plugins/lib/dotrules.js';

test('matchPattern: exact, prefix, star', () => {
  assert.equal(matchPattern('bash', 'bash'), true);
  assert.equal(matchPattern('bash', 'ba'), false);
  assert.equal(matchPattern('bash', 'ba*'), true);
  assert.equal(matchPattern('bash', '*'), true);
  assert.equal(matchPattern('web_fetch', 'web_*'), true);
  assert.equal(matchPattern('webfetch', 'web_*'), false);
});

test('decide: deny beats ask beats allow', () => {
  const policy = { mode: 'enforce', allow: ['*'], ask: ['bash'], deny: ['bash*'] };
  assert.deepEqual(decide(policy, 'bash'), { level: 'deny', rule: 'bash*' });
  // remove deny → ask wins over allow
  assert.deepEqual(decide({ ...policy, deny: [] }, 'bash'), { level: 'ask', rule: 'bash' });
  // untouched tools fall through to allow
  assert.deepEqual(decide(policy, 'read'), { level: 'allow', rule: '*' });
});

test('decide: unmatched tool with restrictive allow falls to default allow', () => {
  const policy = { mode: 'advisory', allow: ['read'], ask: [], deny: [] };
  assert.deepEqual(decide(policy, 'bash'), { level: 'allow', rule: '(default)' });
});

test('sanitize: non-object input falls back to default and reports invalid', () => {
  for (const raw of [null, undefined, 42, 'nope', ['allow']]) {
    const { policy, valid } = sanitize(raw);
    assert.equal(valid, false, `raw=${JSON.stringify(raw)}`);
    assert.deepEqual(policy, { ...DEFAULT_POLICY });
  }
});

test('sanitize: fills missing arrays and enforces permissive allow', () => {
  const { policy, valid } = sanitize({ mode: 'enforce', ask: ['bash'] });
  assert.equal(valid, true);
  assert.equal(policy.mode, 'enforce');
  assert.deepEqual(policy.allow, ['*']);
  assert.deepEqual(policy.ask, ['bash']);
  assert.deepEqual(policy.deny, []);
});

test('sanitize: empty allow list resets to star; non-strings filtered', () => {
  const { policy } = sanitize({ allow: [], ask: ['bash', 7, null], deny: [false, 'bash'] });
  assert.deepEqual(policy.allow, ['*']);
  assert.deepEqual(policy.ask, ['bash']);
  assert.deepEqual(policy.deny, ['bash']);
});

test('sanitize: unknown mode degrades to advisory', () => {
  assert.equal(sanitize({ mode: 'yolo' }).policy.mode, 'advisory');
});
