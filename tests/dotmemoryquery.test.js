import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRecallQuery,
  lineTags,
  recencyWeight,
  scoreRecallLine,
  rankRecall,
} from '../plugins/lib/dotmemoryquery.js';

const NOW = Date.parse('2026-10-05T00:00:00.000Z');
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();
const mem = (days, fact, tags = '') => `- [${daysAgo(days)}] ${fact}${tags ? ' ' + tags : ''}`;

test('parseRecallQuery splits plain words into lowercased terms', () => {
  assert.deepEqual(parseRecallQuery('Castai EKS Onboarding'), {
    terms: ['castai', 'eks', 'onboarding'],
    tags: [],
  });
});

test('parseRecallQuery: tag:x and #x become tag filters, not terms', () => {
  assert.deepEqual(parseRecallQuery('rollout tag:prod #eu-west'), {
    terms: ['rollout'],
    tags: ['prod', 'eu-west'],
  });
});

test('parseRecallQuery: junk-only queries parse to empty', () => {
  assert.deepEqual(parseRecallQuery('   '), { terms: [], tags: [] });
  assert.deepEqual(parseRecallQuery('# tag: '), { terms: [], tags: [] });
});

test('lineTags extracts lowercased #tags from a memory line', () => {
  assert.deepEqual(lineTags(mem(0, 'Deploy EU cluster', '#CastAI #prod')), ['castai', 'prod']);
  assert.deepEqual(lineTags(mem(0, 'no tags here')), []);
});

test('recencyWeight: 1 for now, halves monthly-ish, floors at 0.25', () => {
  assert.equal(recencyWeight(mem(0, 'x'), NOW), 1);
  const month = recencyWeight(mem(30, 'x'), NOW);
  assert.ok(month > 0.5 && month < 0.65, `one month ≈ 0.56, got ${month}`);
  assert.ok(recencyWeight(mem(3650, 'x'), NOW) >= 0.25);
});

test('recencyWeight: undated or malformed stamps get a neutral 0.6', () => {
  assert.equal(recencyWeight('- [not-a-date] x', NOW), 0.6);
  assert.equal(recencyWeight('- stray line without stamp', NOW), 0.6);
});

test('scoreRecallLine: full-coverage old line beats partial-coverage fresh line', () => {
  const parsed = parseRecallQuery('deploy eu cluster');
  const fullOld = scoreRecallLine(mem(120, 'deploy eu cluster with terraform'), parsed, NOW);
  const partialFresh = scoreRecallLine(mem(0, 'deploy notes'), parsed, NOW);
  assert.ok(fullOld > partialFresh, `full old ${fullOld} beats partial fresh ${partialFresh}`);
});

test('scoreRecallLine: same coverage, fresher line scores higher', () => {
  const parsed = parseRecallQuery('deploy');
  const fresh = scoreRecallLine(mem(1, 'deploy notes'), parsed, NOW);
  const stale = scoreRecallLine(mem(400, 'deploy notes'), parsed, NOW);
  assert.ok(fresh > stale);
});

test('scoreRecallLine: a missing tag filter zeroes the line', () => {
  const parsed = parseRecallQuery('deploy tag:prod');
  assert.equal(scoreRecallLine(mem(0, 'deploy notes', '#staging'), parsed, NOW), 0);
  assert.ok(scoreRecallLine(mem(0, 'deploy notes', '#prod'), parsed, NOW) > 0);
});

test('scoreRecallLine: no term hits zeroes the line when terms exist', () => {
  const parsed = parseRecallQuery('kubernetes');
  assert.equal(scoreRecallLine(mem(0, 'ldap notes'), parsed, NOW), 0);
});

test('rankRecall: empty or absent query keeps newest-first order', () => {
  const text = [mem(10, 'oldest'), mem(2, 'middle'), mem(0, 'newest')].join('\n');
  assert.deepEqual(rankRecall(text, '', { nowMs: NOW }).map((l) => l.split('] ')[1]), [
    'newest',
    'middle',
    'oldest',
  ]);
  assert.deepEqual(rankRecall(text, undefined, { nowMs: NOW, limit: 2 }).length, 2);
});

test('rankRecall: multi-term query ranks sensibly across age and coverage', () => {
  const text = [
    mem(90, 'eks onboarding terraform stack lives in Documents/castai'), // full coverage, old
    mem(0, 'terraform state gotcha'), // 1 of 3 terms, brand new
    mem(30, 'eks onboarding docs'), // 2 of 3 terms, mid-age
  ].join('\n');
  const hits = rankRecall(text, 'eks onboarding terraform', { nowMs: NOW });
  assert.ok(hits[0].includes('Documents/castai'), 'full coverage ranks first despite age');
  assert.ok(hits[1].includes('eks onboarding docs'), 'two terms beat one');
  assert.equal(hits.length, 3);
});

test('rankRecall: tag filter narrows to tagged lines only', () => {
  const text = [mem(1, 'rollout notes for staging', '#staging'), mem(5, 'rollout notes for prod', '#prod')].join('\n');
  const hits = rankRecall(text, 'rollout tag:prod', { nowMs: NOW });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].includes('prod'));
});

test('rankRecall: ties prefer the later (newer-in-file) line; limit caps', () => {
  const stamp = daysAgo(3);
  const text = [`- [${stamp}] deploy alpha`, `- [${stamp}] deploy beta`, `- [${stamp}] deploy gamma`].join('\n');
  const hits = rankRecall(text, 'deploy', { nowMs: NOW, limit: 2 });
  assert.deepEqual(hits.map((l) => l.split('deploy ')[1]), ['gamma', 'beta']);
});

test('rankRecall: ignores non-memory lines and tolerates junk input', () => {
  const text = '# Memory\n\nnot a fact line\n' + mem(1, 'real fact about dns');
  assert.deepEqual(rankRecall(text, 'dns', { nowMs: NOW }), [text.split('\n').pop()]);
  assert.deepEqual(rankRecall(null, 'dns', { nowMs: NOW }), []);
});
