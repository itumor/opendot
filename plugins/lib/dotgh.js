/**
 * dotgh — GitHub webhooks for the dot: signature verification + event→task.
 *
 * Two halves, both pure:
 *
 *   verifyGitHubSignature  proves a POST to /dot/hook/github really came
 *                          from GitHub (HMAC-SHA-256 over the RAW body with
 *                          the webhook secret, X-Hub-Signature-256 header,
 *                          timing-safe compare — no secret, no entry);
 *
 *   mapGitHubEvent         turns a verified (event, payload) pair into ONE
 *                          inbox task line the goal loop can act on — CI
 *                          failure → investigate, issue opened → triage,
 *                          mentions → look. Returns null for events worth
 *                          acknowledging but not enqueuing (nothing there is
 *                          work), and degrades every missing payload field to
 *                          a shrug rather than a throw: webhook payloads are
 *                          attacker-shaped until proven otherwise.
 *
 * The bridge never stores payload bodies in the inbox item message — just a
 * clipped summary — because inbox.jsonl is model-facing context: keep it
 * small, keep it task-shaped.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * True only for a well-formed `sha256=<hmac-sha256(secret, raw)>` header.
 * `raw` must be the exact request body string — verify BEFORE parsing.
 */
export function verifyGitHubSignature(secret, raw, header) {
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const presented = header.slice('sha256='.length);
  if (!HEX64.test(presented)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(String(raw ?? ''), 'utf8').digest('hex'), 'utf8');
  const given = Buffer.from(presented.toLowerCase(), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const clip = (value, max) => {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const repo = (payload) => clip(payload?.repository?.full_name, 120) || '(unknown repo)';

/**
 * Map one GitHub event to { name, message } for the inbox, or null for
 * "acknowledged, nothing to do". `payload` may be null (unparseable body).
 */
export function mapGitHubEvent(event, payload) {
  const action = typeof payload?.action === 'string' ? payload.action : '';
  const repoName = repo(payload);
  switch (event) {
    case 'ping':
      return { name: 'github-ping', message: `GitHub webhook ping for ${repoName} — wiring verified, no action needed` };

    case 'issues': {
      const n = payload?.issue?.number;
      const title = clip(payload?.issue?.title, 120);
      if (action === 'opened')
        return { name: `github-issue-${n}`, message: `GitHub: issue #${n} opened in ${repoName}: "${title}" — triage: read it, decide worth/doability, label or answer` };
      if (action === 'closed')
        return { name: `github-issue-${n}`, message: `GitHub: issue #${n} closed in ${repoName} ("${title}") — reconcile: was this the dot's work? update tasks/projects if so` };
      return { name: `github-issue-${n ?? '?'}`, message: `GitHub: issue #${n ?? '?'} ${action || 'changed'} in ${repoName} ("${title}") — glance` };
    }

    case 'issue_comment': {
      const n = payload?.issue?.number;
      const who = clip(payload?.comment?.user?.login, 60) || 'someone';
      const snippet = clip(payload?.comment?.body, 160);
      return {
        name: `github-comment-${n ?? '?'}`,
        message: `GitHub: ${who} commented on #${n ?? '?'} in ${repoName}: "${snippet}" — triage (dot mentioned? answer needed?)`,
      };
    }

    case 'pull_request': {
      const n = payload?.pull_request?.number;
      const title = clip(payload?.pull_request?.title, 120);
      const merged = payload?.pull_request?.merged === true;
      if (action === 'opened' || action === 'synchronize')
        return { name: `github-pr-${n}`, message: `GitHub: PR #${n} ${action} in ${repoName}: "${title}" — review or run tests` };
      if (action === 'closed')
        return { name: `github-pr-${n}`, message: `GitHub: PR #${n} ${merged ? 'merged' : 'closed unmerged'} in ${repoName} ("${title}") — reconcile branches/issues` };
      return { name: `github-pr-${n ?? '?'}`, message: `GitHub: PR #${n ?? '?'} ${action || 'changed'} in ${repoName} ("${title}") — glance` };
    }

    case 'check_run': {
      if (action !== 'completed') return null;
      const conclusion = payload?.check_run?.conclusion;
      if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return null;
      const name = clip(payload?.check_run?.name, 80) || 'check';
      const url = clip(payload?.check_run?.html_url, 200);
      return { name: 'github-ci-failure', message: `GitHub: CI check "${name}" ${conclusion} in ${repoName} — investigate: ${url}` };
    }

    case 'check_suite': {
      if (action !== 'completed') return null;
      const conclusion = payload?.check_suite?.conclusion;
      if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return null;
      const branch = clip(payload?.check_suite?.head_branch, 80) || '?';
      return { name: 'github-ci-failure', message: `GitHub: check suite ${conclusion} on ${branch} in ${repoName} — investigate the failing run` };
    }

    case 'workflow_run': {
      if (action !== 'completed') return null;
      const conclusion = payload?.workflow_run?.conclusion;
      if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return null;
      const name = clip(payload?.workflow_run?.name, 80) || 'workflow';
      const branch = clip(payload?.workflow_run?.head_branch, 80) || '?';
      const url = clip(payload?.workflow_run?.html_url, 200);
      return { name: 'github-ci-failure', message: `GitHub: workflow "${name}" ${conclusion} on ${branch} in ${repoName} — investigate: ${url}` };
    }

    case 'push': {
      const ref = clip(payload?.ref, 120).replace('refs/heads/', '');
      const count = Array.isArray(payload?.commits) ? payload.commits.length : '?';
      return { name: 'github-push', message: `GitHub: push to ${repoName}/${ref} (${count} commits) — note; run the suite if it touches plugins/` };
    }

    default:
      return {
        name: `github-${clip(event, 40) || 'unknown'}`,
        message: `GitHub: ${clip(event, 40) || 'unknown'} event${action ? ` (${action})` : ''} on ${repoName} — triage`,
      };
  }
}
