import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readBody, parseUrl, checkSecret, escapeHtml, clip } from '../plugins/lib/dothttp.js';
import { renderDashboard } from '../plugins/dot-events.js';

function fakeReq(chunks, headers = {}) {
  const req = Readable.from(chunks.map((c) => Buffer.from(c)));
  req.headers = headers;
  return req;
}

test('parseUrl: pathname, query, trailing-slash trim, garbage tolerance', () => {
  assert.deepEqual(parseUrl('/dot/hook/github?secret=s&x=1'), {
    pathname: '/dot/hook/github',
    query: { secret: 's', x: '1' },
  });
  assert.deepEqual(parseUrl('/dot/inbox/?a=1&a=2'), { pathname: '/dot/inbox', query: { a: '2' } });
  // garbage never throws: it resolves as a relative path against the dummy base
  const junk = parseUrl(':::garbage');
  assert.ok(junk.pathname.startsWith('/'));
  assert.deepEqual(junk.query, {});
});

test('checkSecret: open when unset, header or query when set', () => {
  assert.equal(checkSecret(null, { headers: {} }, {}), true);
  assert.equal(checkSecret('s3', { headers: { 'x-dot-secret': 's3' } }, {}), true);
  assert.equal(checkSecret('s3', { headers: {} }, { secret: 's3' }), true);
  assert.equal(checkSecret('s3', { headers: { 'x-dot-secret': 'wrong' } }, {}), false);
  assert.equal(checkSecret('s3', { headers: {} }, {}), false);
});

test('readBody: small body round-trips', async () => {
  const body = await readBody(fakeReq(['{"a":', '1}']), 1024);
  assert.deepEqual(body, { ok: true, error: null, text: '{"a":1}' });
});

test('readBody: over-limit destroys and reports too-large', async () => {
  const req = fakeReq(['x'.repeat(64)]);
  const body = await readBody(req, 10);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'too-large');
  assert.equal(req.destroyed, true);
});

test('escapeHtml escapes the five dangerous characters', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('clip: truncates with ellipsis, stringifies non-strings, handles null', () => {
  assert.equal(clip('abcdef', 3), 'abc…');
  assert.equal(clip('abc', 3), 'abc');
  assert.equal(clip({ a: 1 }, 50), '{"a":1}');
  assert.equal(clip(null), '');
  assert.equal(clip(undefined), '');
});

test('renderDashboard escapes hostile journal payloads', () => {
  const html = renderDashboard({
    home: '/tmp/dot',
    generatedAt: '2026-10-04T20:00:00.000Z',
    selfUrl: '/dot/status',
    status: { policyMode: 'advisory', inboxPending: 1, schedules: 0, schedulesDue: 0, lastHeartbeat: null },
    schedules: [],
    routes: [{ path: '/dot/inbox', owned: true }],
    journal: [{ at: '2026-10-04T20:00:00Z', kind: 'webhook', payload: '<script>alert(1)</script>' }],
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw payload must not appear');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped payload must appear');
  assert.ok(html.includes('dot status'), 'shell renders');
});
