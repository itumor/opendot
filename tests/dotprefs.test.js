import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBullets, formatFeedback, normalizeSignal, signalGlyph } from '../plugins/lib/dotprefs.js';

const DOC = `# Preferences

## curated

- answers in lowercase
- never touch prod on friday

## feedback log

- [2026-10-04T20:00:00Z] (+) loved the terse summary  [context: weekly report]
- [2026-10-04T20:05:00Z] (-) too many probing tool calls  [context: round 31]

## unrelated

- should not appear
`;

test('parseBullets reads a named section up to the next heading', () => {
  assert.deepEqual(parseBullets(DOC, 'curated'), ['answers in lowercase', 'never touch prod on friday']);
  assert.equal(parseBullets(DOC, 'feedback log').length, 2);
  assert.deepEqual(parseBullets(DOC, 'feedback log')[0], '- [2026-10-04T20:00:00Z] (+) loved the terse summary  [context: weekly report]'.slice(2));
});

test('parseBullets tolerates missing sections and bad input', () => {
  assert.deepEqual(parseBullets(DOC, 'nope'), []);
  assert.deepEqual(parseBullets('', 'curated'), []);
  assert.deepEqual(parseBullets(null, 'curated'), []);
  assert.deepEqual(parseBullets(DOC, undefined), []);
});

test('parseBullets ignores placeholder "(none …)" bullets and blanks', () => {
  const doc = '## curated\n\n(none yet — distilled later)\n-   \n';
  assert.deepEqual(parseBullets(doc, 'curated'), []);
});

test('heading match is case-insensitive; unrelated sections stay out', () => {
  assert.deepEqual(parseBullets(DOC, 'CURATED'), parseBullets(DOC, 'curated'));
  assert.ok(!parseBullets(DOC, 'curated').includes('should not appear'));
});

test('normalizeSignal + signalGlyph map to (+), (−), (~)', () => {
  assert.equal(normalizeSignal('positive'), 'positive');
  assert.equal(normalizeSignal('negative'), 'negative');
  assert.equal(normalizeSignal('garbage'), 'neutral');
  assert.equal(signalGlyph('positive'), '+');
  assert.equal(signalGlyph('negative'), '-');
  assert.equal(signalGlyph('neutral'), '~');
});

test('formatFeedback shapes one append-only log line', () => {
  const line = formatFeedback({ signal: 'negative', note: '  too   many\nprobes ', context: 'round 31', at: '2026-10-04T20:05:00Z' });
  assert.equal(line, '- [2026-10-04T20:05:00Z] (-) too many probes  [context: round 31]');
  const bare = formatFeedback({ signal: 'positive', note: 'nice', at: '2026-10-04T20:05:00Z' });
  assert.equal(bare, '- [2026-10-04T20:05:00Z] (+) nice');
});
