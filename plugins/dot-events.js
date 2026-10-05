/**
 * dot-events — the dot's ears: HTTP triggers in, an activity surface out.
 *
 * OpenAI's dots are reachable where the operator works and give the operator
 * an activity view of background work. This plugin is the v0.2 slice of both:
 *
 *   GET|POST /dot/inbox    enqueue a trigger (cron-friendly, curl-friendly)
 *   POST     /dot/hook/*   named webhook ingress; the tail of the path is the
 *                          event name, the body (JSON when parseable) is the
 *                          payload — wire GitHub/Slack/Grafana here today
 *   GET      /dot/status   activity view: HTML dashboard for a browser,
 *                          JSON for machines (Accept: application/json)
 *
 * Everything lands in inbox.jsonl as a trigger; the standing goal loop drains
 * it and does the thinking. This plugin never calls a model — same write-only
 * wake path as the scheduler.
 *
 * Composition notes:
 *  - webServer is a HOST service and may be absent (CLI sessions, or another
 *    preset owning the routes). It is resolved SOFTLY: without it the dot
 *    keeps every other organ, only the HTTP ears are missing, and the status
 *    surface reports that instead of failing the fiber.
 *  - Route ownership conflicts (a second dot session in one process) degrade
 *    per-route: the first registrant keeps the route, later dots report the
 *    conflict on their status page. Both write to the same dot home, so the
 *    bus stays functionally single-owner by file, not by route object.
 *  - An optional shared secret (`config.secret`) gates the write endpoints;
 *    /dot/status is always open because it exposes nothing writable and the
 *    default bind is loopback.
 *  - An optional GitHub webhook secret (`config.ghSecret`) turns
 *    POST /dot/hook/github into the GitHub bridge: X-Hub-Signature-256
 *    verified (HMAC-SHA-256 over the raw body, timing-safe), events mapped
 *    to task-shaped inbox items (CI failure → investigate; issue opened or
 *    commented → triage), junk acknowledged but not enqueued. Without the
 *    secret the path stays an ordinary raw webhook.
 */
import { statSync } from 'node:fs';

// Cache-proof repo-internal imports — see the header of dot-core.js for why
// the mtime stamp is load-bearing (stale per-URL module cache across preset
// remounts). Keep every './lib/…' specifier behind fresh(). In particular:
// this organ was born in v0.2 while a v0.1 dotstore (without readTail) was
// still cached — the "does not provide an export named 'readTail'" failure.
const fresh = (rel) => {
  const url = new URL(rel, import.meta.url);
  url.search = `?mtime=${statSync(url).mtimeMs}`;
  return url.href;
};
const { readJsonLines, readTail, nowIso } = await import(fresh('./lib/dotstore.js'));
const { readBody, parseUrl, checkSecret, sendJson, sendHtml, escapeHtml, clip } = await import(fresh('./lib/dothttp.js'));
const { verifyGitHubSignature, mapGitHubEvent } = await import(fresh('./lib/dotgh.js'));
const { dotTool } = await import(fresh('./lib/dottool.js'));

export const name = 'dot-events';
export const inject = ['dotCore', 'tools'];

const BODY_LIMIT = 256 * 1024;
const STATUS_JOURNAL_TAIL_BYTES = 32 * 1024;
const STATUS_DASHBOARD_LINES = 40;

/** Render the operator-facing activity view. Pure: no I/O, all data escaped. */
export function renderDashboard(view) {
  const s = view.status ?? {};
  const esc = escapeHtml;
  const scheduleRows = (view.schedules ?? [])
    .map(
      (item) =>
        `<tr><td>${esc(item.name)}</td><td>${item.kind === 'every' ? `every ${esc(item.everySeconds)}s` : `at ${esc(item.at)}`}</td>` +
        `<td>${esc(item.nextAt ?? '')}</td><td>${esc(item.fired ?? 0)}</td></tr>`,
    )
    .join('');
  const journalRows = (view.journal ?? [])
    .slice()
    .reverse()
    .slice(0, STATUS_DASHBOARD_LINES)
    .map((entry) => `<tr><td class="t">${esc(clip(entry.at, 24))}</td><td>${esc(entry.kind ?? '')}</td><td>${esc(clip(entry, 220))}</td></tr>`)
    .join('');
  const routeRows = (view.routes ?? [])
    .map((r) => `<tr><td>${esc(r.path)}</td><td class="${r.owned ? 'ok' : 'bad'}">${r.owned ? 'this dot' : esc(r.note)}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<title>dot status</title>
<style>
body{font:14px/1.45 ui-monospace,Menlo,monospace;background:#0d1117;color:#c9d1d9;margin:0;padding:24px;max-width:1100px}
h1{font-size:18px;color:#58a6ff}h2{font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-top:28px}
table{border-collapse:collapse;width:100%}td{border-top:1px solid #21262d;padding:4px 8px;vertical-align:top;word-break:break-word}
td.t{color:#8b949e;white-space:nowrap}.ok{color:#3fb950}.bad{color:#f85149}.dim{color:#8b949e}
dl{display:flex;gap:24px;flex-wrap:wrap}dt{color:#8b949e;font-size:12px}dd{margin:0;font-size:16px}
</style></head><body>
<h1>● dot status</h1>
<dl>
<div><dt>home</dt><dd>${esc(view.home)}</dd></div>
<div><dt>policy</dt><dd>${esc(s.policyMode ?? '?')}</dd></div>
<div><dt>inbox pending</dt><dd>${esc(s.inboxPending ?? '?')}</dd></div>
<div><dt>schedules due</dt><dd>${esc(s.schedulesDue ?? '?')} / ${esc(s.schedules ?? '?')}</dd></div>
<div><dt>last heartbeat</dt><dd>${esc(s.lastHeartbeat ?? 'none')}</dd></div>
<div><dt>generated</dt><dd>${esc(view.generatedAt)}</dd></div>
</dl>
<h2>http ears</h2>
<table>${routeRows || '<tr><td class="dim">no webServer — routes inactive</td></tr>'}</table>
<h2>schedules</h2>
<table>${scheduleRows || '<tr><td class="dim">none armed</td></tr>'}</table>
<h2>recent journal</h2>
<table>${journalRows || '<tr><td class="dim">journal is empty</td></tr>'}</table>
<p class="dim">auto-refresh 15s · JSON: <a style="color:#58a6ff" href="${esc(view.selfUrl)}?format=json">?format=json</a></p>
</body></html>`;
}

export function apply(ctx, config = {}) {
  const core = ctx.dotCore;
  const routePaths = {
    inbox: typeof config.inboxPath === 'string' ? config.inboxPath : '/dot/inbox',
    hook: typeof config.hookPrefix === 'string' ? config.hookPrefix : '/dot/hook',
    status: typeof config.statusPath === 'string' ? config.statusPath : '/dot/status',
  };
  const secret = typeof config.secret === 'string' && config.secret !== '' ? config.secret : null;
  // GitHub webhook secret: when set, POST /dot/hook/github becomes an
  // HMAC-verified, event-mapped bridge instead of a raw webhook.
  const ghSecret = typeof config.ghSecret === 'string' && config.ghSecret !== '' ? config.ghSecret : null;

  // Soft host-service lookups: absent services degrade features, never fibers.
  let webServer = null;
  let scheduler = null;
  try {
    webServer = ctx.get('webServer') ?? null;
  } catch {
    webServer = null;
  }
  try {
    scheduler = ctx.get('dotScheduler') ?? null;
  } catch {
    scheduler = null;
  }

  // Route ownership bookkeeping: what this dot answers, and what someone else
  // registered first (reported on the status surface, not fought over).
  const owned = [];
  const conflicts = [];

  async function enqueue(item) {
    await core.inboxAppend(item);
    await core.journal({ kind: 'event-received', event: item.kind, name: item.name ?? item.from ?? '' });
  }

  async function handleInbox(req, res) {
    const { query } = parseUrl(req.url);
    if (!checkSecret(secret, req, query)) return sendJson(res, 401, { ok: false, error: 'bad secret' });
    let from = clip(query.from, 80) || 'http';
    let message = clip(query.message, 2000);
    let payload;
    if (req.method === 'POST') {
      const body = await readBody(req, BODY_LIMIT);
      if (!body.ok) return sendJson(res, 413, { ok: false, error: body.error });
      try {
        const data = body.text ? JSON.parse(body.text) : {};
        if (typeof data.from === 'string') from = clip(data.from, 80);
        if (typeof data.message === 'string') message = clip(data.message, 2000);
        if (data.payload !== undefined) payload = data.payload;
      } catch {
        if (body.text) message = clip(body.text, 2000);
      }
    } else if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
    }
    if (message === '') return sendJson(res, 400, { ok: false, error: 'message is required' });
    await enqueue({ kind: 'external', from, message, ...(payload !== undefined ? { payload } : {}) });
    return sendJson(res, 200, { ok: true, queued: message.slice(0, 80) });
  }

  async function handleHook(req, res) {
    const { pathname, query } = parseUrl(req.url);
    if (!checkSecret(secret, req, query)) return sendJson(res, 401, { ok: false, error: 'bad secret' });
    if (req.method !== 'POST') {
      return sendJson(res, 405, {
        ok: false,
        error: 'POST only',
        usage: `curl -X POST ${routePaths.hook}/<event-name> -d '{"any":"json"}'`,
      });
    }
    const name = clip(pathname.slice(routePaths.hook.length).replace(/^\/+/, ''), 80) || 'unnamed';
    const body = await readBody(req, BODY_LIMIT);
    if (!body.ok) return sendJson(res, 413, { ok: false, error: body.error });

    // GitHub bridge: with ghSecret configured, /dot/hook/github only accepts
    // HMAC-authenticated deliveries and lands as a task-shaped inbox item.
    if (name === 'github' && ghSecret !== null) {
      const signature = req.headers ? req.headers['x-hub-signature-256'] : undefined;
      if (!verifyGitHubSignature(ghSecret, body.text, signature)) {
        await core.journal({ kind: 'github-hook-rejected', reason: 'bad-signature' });
        return sendJson(res, 401, { ok: false, error: 'bad signature' });
      }
      const event = clip(req.headers?.['x-github-event'] ?? '', 60) || 'unknown';
      let ghPayload = null;
      if (body.text !== '') {
        try {
          ghPayload = JSON.parse(body.text);
        } catch {
          ghPayload = null;
        }
      }
      await core.journal({
        kind: 'github-event',
        event,
        action: clip(ghPayload?.action ?? '', 40),
        repo: clip(ghPayload?.repository?.full_name ?? '', 120),
      });
      const mapped = mapGitHubEvent(event, ghPayload);
      if (mapped === null) return sendJson(res, 202, { ok: true, event, ignored: true });
      const summary = ghPayload === null ? undefined : clip(JSON.stringify(ghPayload), 8000);
      await enqueue({ kind: 'github', name: mapped.name, from: `github:${event}`, message: mapped.message, ...(summary !== undefined ? { payload: summary } : {}) });
      return sendJson(res, 202, { ok: true, event, queued: mapped.name });
    }

    let payload = null;
    if (body.text !== '') {
      try {
        payload = JSON.parse(body.text);
      } catch {
        payload = { raw: clip(body.text, 8000) };
      }
    }
    await enqueue({ kind: 'webhook', name, from: `webhook:${name}`, message: `webhook "${name}" received`, payload });
    return sendJson(res, 202, { ok: true, event: name });
  }

  async function statusView() {
    const [journal, schedules] = await Promise.all([
      readTail(core.paths.journal, STATUS_JOURNAL_TAIL_BYTES, '').then((tail) => {
        const out = [];
        for (const line of tail.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            out.push(JSON.parse(trimmed));
          } catch {
            /* torn tail line: skip */
          }
        }
        return out;
      }),
      scheduler !== null ? scheduler.list().catch(() => []) : Promise.resolve([]),
    ]);
    return {
      home: core.root,
      status: core.status(),
      schedules,
      journal,
      generatedAt: nowIso(),
      selfUrl: routePaths.status,
      routes: [
        { path: routePaths.inbox, owned: owned.includes('inbox'), note: conflicts.includes('inbox') ? 'owned elsewhere' : 'inactive' },
        { path: `${routePaths.hook}/*`, owned: owned.includes('hook'), note: conflicts.includes('hook') ? 'owned elsewhere' : 'inactive' },
        { path: routePaths.status, owned: owned.includes('status'), note: conflicts.includes('status') ? 'owned elsewhere' : 'inactive' },
      ],
    };
  }

  async function handleStatus(req, res) {
    const { query } = parseUrl(req.url);
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const view = await statusView();
    const wantsHtml = query.format !== 'json' && String(req.headers.accept ?? 'text/html').includes('text/html');
    if (wantsHtml) return sendHtml(res, 200, renderDashboard(view));
    return sendJson(res, 200, view);
  }

  // Register what the host lets us. A duplicate (kind, path) throws — that is
  // a composition conflict to report, never a reason to take the fiber down.
  if (webServer !== null) {
    const disposers = [];
    const attempt = (key, route) => {
      try {
        disposers.push(webServer.register(route));
        owned.push(key);
      } catch (error) {
        conflicts.push(key);
        void core.journal({
          kind: 'event-route-conflict',
          path: route.path,
          error: String(error && error.message ? error.message : error),
        });
      }
    };
    attempt('inbox', { kind: 'exact', path: routePaths.inbox, handler: handleInbox });
    attempt('hook', { kind: 'prefix', path: routePaths.hook, handler: handleHook });
    attempt('status', { kind: 'exact', path: routePaths.status, handler: handleStatus });
    if (disposers.length > 0) {
      ctx.effect(() => () => {
        for (const dispose of disposers) dispose();
      });
    }
  }

  void core.journal({
    kind: 'boot',
    plugin: 'dot-events',
    webServer: webServer !== null,
    owned,
    conflicts: conflicts.length,
    secret: secret !== null,
    ghBridge: ghSecret !== null,
  });

  const eventsApi = {
    /** Model-initiated self-trigger: queued for the next goal round. */
    emit: (message, from) => enqueue({ kind: 'self', from: from ?? 'dot', message: clip(message, 2000) }),
    routes: () => ({ owned: [...owned], conflicts: [...conflicts], webServer: webServer !== null }),
    statusView,
  };
  ctx.provide('dotEvents', eventsApi);

  ctx.tools.register(
    dotTool({
      name: 'dot_event',
      description:
        "Emit an event into the dot's own inbox (a self-nudge the next goal round will drain and act on), or report which HTTP event routes this dot owns. Webhooks from the outside arrive by themselves; use emit when you want to defer work to your next round.",
      properties: {
        action: { type: 'string', enum: ['emit', 'routes'], description: 'Operation to perform.' },
        message: { type: 'string', description: 'Instruction to your next round (required for emit).' },
        from: { type: 'string', description: 'Origin label (optional).' },
      },
      required: ['action'],
      async execute(args) {
        switch (args.action) {
          case 'emit': {
            if (typeof args.message !== 'string' || args.message.trim() === '') return 'message is required for emit';
            await eventsApi.emit(args.message.trim(), typeof args.from === 'string' ? args.from : 'dot');
            return `queued for next round: ${args.message.trim().slice(0, 120)}`;
          }
          case 'routes': {
            const report = eventsApi.routes();
            if (!report.webServer) return 'webServer unavailable — no HTTP routes active (inbox.jsonl append still works)';
            const lines = [];
            if (report.owned.length > 0) lines.push(`owned: ${report.owned.join(', ')}`);
            if (report.conflicts.length > 0) lines.push(`conflicts (registered elsewhere, left alone): ${report.conflicts.join(', ')}`);
            return lines.length > 0 ? lines.join('\n') : 'no routes registered';
          }
          default:
            return `unknown action: ${String(args.action)}`;
        }
      },
    }),
  );
}
