/**
 * dot-core — the dot's body: state root, key/value store, inbox, heartbeat,
 * journal, and the live status the model sees every step.
 *
 * # Layout (all under `config.root`, the dot home)
 *
 *   kv.json            durable key/value state (survives context compaction)
 *   inbox.jsonl        pending external/scheduled triggers, one JSON per line
 *   inbox.done.jsonl   drained triggers (audit)
 *   heartbeat.log      liveness pulse appended by dot-scheduler
 *   journal.jsonl      append-only event journal (audit spine)
 *   memory.md          long-term notes (managed by dot-memory)
 *   policy.json        autonomy rules (managed by dot-policy)
 *   schedule.json      durable schedules (managed by dot-scheduler)
 *   status/            daily rollup pages, status/YYYY-MM-DD.md (dot-report)
 *   README.md          operator-facing map of this directory
 *
 * Everything is files: the operator can read and edit every piece of their
 * dot with any editor, and the dot can rebuild from any half-written state.
 */
import { join } from 'node:path';
import { rename, appendFile, unlink } from 'node:fs/promises';
import { statSync } from 'node:fs';

// Cache-proof repo-internal imports. DSH preset file rows are imported once
// per process and Node caches modules by URL, so a remounted preset would
// silently keep running the first version it ever saw — or fail the whole
// mount with "does not provide an export named …" when a stale cached helper
// lacks an export a newer organ asks for (that failure is why this exists).
// Stamping every repo-internal specifier with the file's own mtime makes the
// CONTENT the cache key: editing takes effect on the next mount, as the
// preset documents. One level up, the *.entry.js shims re-import these
// organs behind a per-mount-unique query, so organ edits land the same way.
const fresh = (rel) => {
  const url = new URL(rel, import.meta.url);
  url.search = `?mtime=${statSync(url).mtimeMs}`;
  return url.href;
};
const {
  ensureDir,
  readJson,
  writeJsonAtomic,
  appendLine,
  readText,
  readJsonLines,
  nowIso,
} = await import(fresh('./lib/dotstore.js'));
const { dotTool } = await import(fresh('./lib/dottool.js'));

/** First-boot content; written only when the file is absent. */
const SEEDS = {
  'kv.json': () => '{}\n',
  'memory.md': () =>
    '# dot long-term memory\n\nAppend-only facts the dot chose to retain. Managed by the dot_remember/dot_recall tools.\n',
  'policy.json': (root) =>
    JSON.stringify(
      {
        mode: 'advisory',
        note: 'advisory = rules only guide the model via its prompt; enforce = the dot_policy rules also gate tool execution',
        allow: ['*'],
        ask: [],
        deny: [],
      },
      null,
      2,
    ) + '\n',
  'schedule.json': () => JSON.stringify({ version: 1, items: [] }, null, 2) + '\n',
  'journal.jsonl': () => '',
  'inbox.jsonl': () => '',
  'heartbeat.log': () => '',
  'README.md': (root) =>
    `# Dot state\n\nEverything the dot persists lives here as plain files.\n\n- kv.json — durable key/value state (dot_state tool)\n- inbox.jsonl — pending triggers; drained items move to inbox.done.jsonl\n- heartbeat.log — liveness pulse\n- journal.jsonl — append-only audit spine\n- memory.md — long-term notes (dot_remember / dot_recall)\n- policy.json — autonomy rules (dot_policy, dot-policy plugin)\n- schedule.json — durable wakeups (dot_schedule)\n- status/ — daily rollup pages (dot_report)\n\nHome: ${root}\n`,
};

export const name = 'dot-core';
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx, config = {}) {
  const root = typeof config.root === 'string' && config.root.length > 0 ? config.root : null;
  if (root === null) throw new Error('dot-core requires config.root (the dot home directory)');

  const paths = {
    root,
    kv: join(root, 'kv.json'),
    inbox: join(root, 'inbox.jsonl'),
    inboxDone: join(root, 'inbox.done.jsonl'),
    heartbeat: join(root, 'heartbeat.log'),
    journal: join(root, 'journal.jsonl'),
    memory: join(root, 'memory.md'),
    policy: join(root, 'policy.json'),
    schedule: join(root, 'schedule.json'),
  };

  // In-memory status cache: prompt providers are synchronous, file reads are
  // not. Refreshed after every mutation and on every heartbeat tick.
  let statusCache = {
    at: null,
    kvKeys: 0,
    inboxPending: 0,
    schedules: 0,
    schedulesDue: 0,
    policyMode: 'unknown',
    lastHeartbeat: null,
  };

  async function refreshStatus() {
    const [kv, inbox, schedule, policy, heartbeatTail] = await Promise.all([
      readJson(paths.kv, {}),
      readJsonLines(paths.inbox),
      readJson(paths.schedule, { items: [] }),
      readJson(paths.policy, { mode: 'unknown' }),
      readText(paths.heartbeat, ''),
    ]);
    const items = Array.isArray(schedule.items) ? schedule.items : [];
    const now = Date.now();
    const lastLine = heartbeatTail.trim().split('\n').filter(Boolean).pop() ?? null;
    statusCache = {
      at: nowIso(),
      kvKeys: Object.keys(kv).length,
      inboxPending: inbox.length,
      schedules: items.length,
      schedulesDue: items.filter((item) => !item.done && typeof item.nextAt === 'string' && Date.parse(item.nextAt) <= now).length,
      policyMode: typeof policy.mode === 'string' ? policy.mode : 'unknown',
      lastHeartbeat: lastLine === null ? null : lastLine.slice(0, 24),
    };
    return statusCache;
  }

  const core = {
    root,
    paths,

    // ── kv ────────────────────────────────────────────────────────────────
    async kvGet(key) {
      const kv = await readJson(paths.kv, {});
      return Object.hasOwn(kv, key) ? kv[key] : undefined;
    },
    async kvSet(key, value) {
      const kv = await readJson(paths.kv, {});
      kv[key] = value;
      await ensureDir(root);
      await writeJsonAtomic(paths.kv, kv);
      void refreshStatus().catch(() => {});
    },
    async kvRemove(key) {
      const kv = await readJson(paths.kv, {});
      if (Object.hasOwn(kv, key)) {
        delete kv[key];
        await ensureDir(root);
        await writeJsonAtomic(paths.kv, kv);
        void refreshStatus().catch(() => {});
      }
    },
    async kvList() {
      return readJson(paths.kv, {});
    },

    // ── inbox ─────────────────────────────────────────────────────────────
    async inboxAppend(item) {
      await ensureDir(root);
      await appendLine(paths.inbox, JSON.stringify({ at: nowIso(), ...item }));
      void refreshStatus().catch(() => {});
    },
    async inboxPending() {
      return readJsonLines(paths.inbox);
    },
    /**
     * Move every pending item to the done log; returns the drained items.
     * Order matters: copy to the audit log first, then detach the queue, so a
     * crash mid-drain loses nothing. Concurrent appends land in a fresh queue
     * file and survive the drain.
     */
    async inboxDrain() {
      const items = await readJsonLines(paths.inbox);
      if (items.length === 0) return [];
      await ensureDir(root);
      for (const item of items) {
        await appendLine(paths.inboxDone, JSON.stringify({ drainedAt: nowIso(), ...item }));
      }
      const holding = join(root, `inbox.draining-${process.pid}.jsonl`);
      try {
        await rename(paths.inbox, holding);
        await unlink(holding);
      } catch {
        /* queue was recreated by a concurrent appender: leave it in place */
      }
      void refreshStatus().catch(() => {});
      return items;
    },

    // ── liveness + audit ──────────────────────────────────────────────────
    async heartbeat(message) {
      await ensureDir(root);
      const line = `${nowIso()} ${message}`;
      await appendLine(paths.heartbeat, line);
      statusCache = { ...statusCache, lastHeartbeat: line.slice(0, 24) };
    },
    async journal(entry) {
      await ensureDir(root);
      await appendLine(paths.journal, JSON.stringify({ at: nowIso(), ...entry }));
    },
    async journalRead() {
      return readJsonLines(paths.journal);
    },

    // ── status ────────────────────────────────────────────────────────────
    status() {
      return statusCache;
    },
    refreshStatus,
  };

  // Boot: create the home and seed absent files, then prime the status cache.
  // apply() is synchronous; failures degrade into the journal and status.
  void (async () => {
    try {
      await ensureDir(root);
      for (const [file, seed] of Object.entries(SEEDS)) {
        const target = join(root, file);
        if ((await readText(target, null)) === null) {
          await appendFile(target, typeof seed === 'function' ? seed(root) : seed, 'utf8');
        }
      }
      await core.journal({ kind: 'boot', plugin: 'dot-core', home: root });
      await refreshStatus();
    } catch (error) {
      // Never take the fiber down at boot; surface through the status block.
      statusCache = { ...statusCache, bootError: String(error && error.message ? error.message : error) };
    }
  })();

  ctx.provide('dotCore', core);

  // Live dot status as runtime context: a few lines in front of the model on
  // every step, refreshed by mutations and the heartbeat tick.
  ctx.systemPrompt.context({
    name: 'dot.status',
    order: 130,
    text: () => {
      if (statusCache.bootError !== undefined) {
        return `DOT STATUS: boot error — ${statusCache.bootError} (state home ${root} unwritable)`;
      }
      const lines = [
        `Dot home: ${root} (files are the source of truth)`,
        `policy mode=${statusCache.policyMode} · inbox pending=${statusCache.inboxPending} · schedules=${statusCache.schedules} (due now=${statusCache.schedulesDue}) · kv keys=${statusCache.kvKeys}`,
        statusCache.lastHeartbeat !== null
          ? `last heartbeat: ${statusCache.lastHeartbeat}Z · status as of ${statusCache.at ?? 'n/a'}`
          : `no heartbeat yet · status as of ${statusCache.at ?? 'n/a'}`,
      ];
      return lines.join('\n');
    },
  });

  ctx.tools.register(
    dotTool({
      name: 'dot_state',
      description:
        "Read or write the dot's durable key/value state (kv.json). Use it for facts that must survive context compaction or session restarts: cursor positions, last-seen values, feature flags, operator preferences.",
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'remove', 'list'], description: 'Operation to perform.' },
        key: { type: 'string', description: 'State key (required for get/set/remove).' },
        value: { description: 'Any JSON value (required for set).' },
      },
      required: ['action'],
      async execute(args) {
        switch (args.action) {
          case 'get': {
            if (typeof args.key !== 'string') return 'key is required for get';
            const value = await core.kvGet(args.key);
            return value === undefined ? `(unset) ${args.key}` : `${args.key} = ${JSON.stringify(value)}`;
          }
          case 'set': {
            if (typeof args.key !== 'string') return 'key is required for set';
            if (!('value' in args)) return 'value is required for set';
            await core.kvSet(args.key, args.value);
            await core.journal({ kind: 'kv-set', key: String(args.key) });
            return `set ${args.key}`;
          }
          case 'remove': {
            if (typeof args.key !== 'string') return 'key is required for remove';
            await core.kvRemove(args.key);
            return `removed ${args.key}`;
          }
          case 'list': {
            const kv = await core.kvList();
            const keys = Object.keys(kv);
            if (keys.length === 0) return '(empty)';
            return keys.map((key) => `${key} = ${JSON.stringify(kv[key]).slice(0, 120)}`).join('\n');
          }
          default:
            return `unknown action: ${String(args.action)}`;
        }
      },
    }),
  );
}
