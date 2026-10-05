import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyGitHubSignature, mapGitHubEvent } from '../plugins/lib/dotgh.js';
import { apply as applyEvents } from '../plugins/dot-events.js';

const SECRET = 'topsecret-webhook-token';
const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

test('verifyGitHubSignature: accepts a well-formed HMAC over the raw body', () => {
  const body = '{"zen":"Keep it logically awesome."}';
  assert.equal(verifyGitHubSignature(SECRET, body, sign(SECRET, body)), true);
});

test('verifyGitHubSignature: rejects wrong secret, missing/odd headers, no secret', () => {
  const body = '{"a":1}';
  assert.equal(verifyGitHubSignature('other', body, sign(SECRET, body)), false);
  assert.equal(verifyGitHubSignature(SECRET, body, undefined), false);
  assert.equal(verifyGitHubSignature(SECRET, body, 'sha1=abc'), false);
  assert.equal(verifyGitHubSignature(SECRET, body, 'sha256=not-hex'), false);
  assert.equal(verifyGitHubSignature('', body, sign('', body)), false);
  assert.equal(verifyGitHubSignature(SECRET, `${body} `, sign(SECRET, body)), false); // raw bytes matter
});

test('mapGitHubEvent: issues opened becomes a triage task', () => {
  const out = mapGitHubEvent('issues', {
    action: 'opened',
    repository: { full_name: 'itumor/opendot' },
    issue: { number: 12, title: 'dot forgets timezones' },
  });
  assert.equal(out.name, 'github-issue-12');
  assert.match(out.message, /issue #12 opened in itumor\/opendot/);
  assert.match(out.message, /triage/);
});

test('mapGitHubEvent: issue comments carry who + snippet', () => {
  const out = mapGitHubEvent('issue_comment', {
    action: 'created',
    repository: { full_name: 'itumor/opendot' },
    issue: { number: 4 },
    comment: { user: { login: 'octocat' }, body: 'hey dot, can you check CI?' },
  });
  assert.match(out.message, /octocat commented on #4/);
  assert.match(out.message, /hey dot/);
});

test('mapGitHubEvent: failing workflow_run asks for investigation, successes stay quiet', () => {
  const fail = mapGitHubEvent('workflow_run', {
    action: 'completed',
    repository: { full_name: 'itumor/opendot' },
    workflow_run: { conclusion: 'failure', name: 'test', head_branch: 'main', html_url: 'https://example/run/5' },
  });
  assert.equal(fail.name, 'github-ci-failure');
  assert.match(fail.message, /workflow "test" failure on main/);
  assert.match(fail.message, /https:\/\/example\/run\/5/);
  assert.equal(
    mapGitHubEvent('workflow_run', { action: 'completed', workflow_run: { conclusion: 'success' } }),
    null,
  );
  assert.equal(mapGitHubEvent('workflow_run', { action: 'in_progress' }), null);
});

test('mapGitHubEvent: check_run failure / push / ping / unknown, and null payloads', () => {
  const run = mapGitHubEvent('check_run', {
    action: 'completed',
    repository: { full_name: 'r' },
    check_run: { conclusion: 'timed_out', name: 'build', html_url: 'u' },
  });
  assert.match(run.message, /CI check "build" timed_out/);
  const push = mapGitHubEvent('push', { repository: { full_name: 'r' }, ref: 'refs/heads/main', commits: [{}, {}] });
  assert.match(push.message, /push to r\/main \(2 commits\)/);
  assert.equal(mapGitHubEvent('ping', { repository: { full_name: 'r' } }).name, 'github-ping');
  assert.match(mapGitHubEvent('star', null).message, /star event on \(unknown repo\)/);
});

// ── organ-level integration: real POSTs through the mounted dot-events ───────

async function sandboxCtx(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dotgh-events-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const inbox = [];
  const journal = [];
  const routes = new Map();
  const ctx = {
    dotCore: {
      root: dir,
      paths: { journal: join(dir, 'journal.jsonl') },
      inboxAppend: async (item) => inbox.push(item),
      journal: async (entry) => journal.push(entry),
      status: () => ({}),
      refreshStatus: async () => ({}),
    },
    tools: { register: () => {} },
    provide: () => {},
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        };
      }
      throw new Error(`unknown service ${name}`);
    },
    effect: () => {},
  };
  return { inbox, journal, routes, ctx };
}

function fakeReqRes(body, headers, url = '/dot/hook/github') {
  const req = Readable.from([Buffer.from(body)]);
  req.url = url;
  req.method = 'POST';
  req.headers = headers;
  const res = {
    code: null,
    body: '',
    writeHead(code) {
      this.code = code;
    },
    end(text) {
      this.body = text ?? '';
    },
  };
  return { req, res };
}

const WORKFLOW_FAILURE = JSON.stringify({
  action: 'completed',
  repository: { full_name: 'itumor/opendot' },
  workflow_run: { conclusion: 'failure', name: 'test', head_branch: 'main', html_url: 'https://x/run/1' },
});

test('dot-events github bridge: signed delivery lands as a task-shaped inbox item', async (t) => {
  const { inbox, journal, routes, ctx } = await sandboxCtx(t);
  applyEvents(ctx, { ghSecret: SECRET });
  const { req, res } = fakeReqRes(WORKFLOW_FAILURE, {
    'x-hub-signature-256': sign(SECRET, WORKFLOW_FAILURE),
    'x-github-event': 'workflow_run',
  });
  await routes.get('/dot/hook').handler(req, res);
  assert.equal(res.code, 202);
  assert.deepEqual(JSON.parse(res.body), { ok: true, event: 'workflow_run', queued: 'github-ci-failure' });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'github');
  assert.match(inbox[0].message, /CI check|workflow "test" failure on main/);
  assert.ok(journal.some((entry) => entry.kind === 'github-event' && entry.repo === 'itumor/opendot'));
});

test('dot-events github bridge: bad signature is 401 and enqueues nothing', async (t) => {
  const { inbox, journal, routes, ctx } = await sandboxCtx(t);
  applyEvents(ctx, { ghSecret: SECRET });
  const { req, res } = fakeReqRes(WORKFLOW_FAILURE, {
    'x-hub-signature-256': sign('forged-secret', WORKFLOW_FAILURE),
    'x-github-event': 'workflow_run',
  });
  await routes.get('/dot/hook').handler(req, res);
  assert.equal(res.code, 401);
  assert.equal(inbox.length, 0);
  assert.ok(journal.some((entry) => entry.kind === 'github-hook-rejected'));
});

test('dot-events github bridge: completed-success events are acked, not enqueued', async (t) => {
  const success = JSON.stringify({ action: 'completed', repository: { full_name: 'r' }, workflow_run: { conclusion: 'success' } });
  const { inbox, routes, ctx } = await sandboxCtx(t);
  applyEvents(ctx, { ghSecret: SECRET });
  const { req, res } = fakeReqRes(success, {
    'x-hub-signature-256': sign(SECRET, success),
    'x-github-event': 'workflow_run',
  });
  await routes.get('/dot/hook').handler(req, res);
  assert.equal(res.code, 202);
  assert.equal(JSON.parse(res.body).ignored, true);
  assert.equal(inbox.length, 0);
});

test('dot-events without ghSecret keeps /dot/hook/github a plain webhook', async (t) => {
  const { inbox, routes, ctx } = await sandboxCtx(t);
  applyEvents(ctx, {});
  const { req, res } = fakeReqRes(WORKFLOW_FAILURE, { 'x-github-event': 'workflow_run' });
  await routes.get('/dot/hook').handler(req, res);
  assert.equal(res.code, 202);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'webhook');
  assert.equal(inbox[0].name, 'github');
});
