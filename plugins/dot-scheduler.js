/**
 * dot-scheduler — the dot's pulse and its durable alarm clock.
 *
 * One interval tick (the heartbeat) does three things:
 *
 *   1. append one line to heartbeat.log — proof of life, even while the
 *      model is idle;
 *   2. fire every schedule whose nextAt passed — each firing lands in
 *      inbox.jsonl, where the dot's standing goal loop picks it up on the
 *      next round and ACTS on it (this is the wake path: the scheduler never
 *      calls a model, it writes; the goal loop does the thinking);
 *   3. refresh the status snapshot the dot.status context shows the model.
 *
 * Schedules live in schedule.json, so they survive DSH restarts: on mount the
 * plugin re-arms anything still pending and fires anything that came due
 * while the process was down (a dot does not miss its alarms by sleeping).
 *
 * Schedule kinds:
 *   every   { id, name, kind: 'every', everySeconds, task, nextAt, fired }
 *   at      { id, name, kind: 'at', at, task, nextAt, fired, done? }
 *
 * `task` is an instruction to the dot itself — text the goal loop will read
 * when it drains the inbox. Firing does not run anything; the dot decides.
 */
import { ensureDir, readJson, writeJsonAtomic } from './lib/dotstore.js';
import { dotTool } from './lib/dottool.js';

/**
 * NOTE on realm shape: dotCore comes from the sibling row inside the same
 * isolated group; timer comes from the host composition. Both declarations
 * are hard dependencies — the row fails to activate rather than run headless.
 */

export const name = 'dot-scheduler';
export const inject = ['dotCore', 'tools', 'timer'];

function newId() {
  return Math.random().toString(36).slice(2, 8);
}

/** Named export so tests can drive the schedule-item validator directly. */
export function normalize(item) {
  if (item === null || typeof item !== 'object') return null;
  if (item.kind === 'every' && typeof item.everySeconds === 'number' && item.everySeconds >= 5) return item;
  if (item.kind === 'at' && typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at))) return item;
  return null;
}

export function apply(ctx, config = {}) {
  const core = ctx.dotCore;
  const heartbeatSeconds =
    typeof config.heartbeatSeconds === 'number' && config.heartbeatSeconds >= 5
      ? Math.min(config.heartbeatSeconds, 3600)
      : 60;

  async function loadSchedule() {
    const doc = await readJson(core.paths.schedule, { version: 1, items: [] });
    const items = (Array.isArray(doc.items) ? doc.items : []).map(normalize).filter(Boolean);
    return { version: 1, items };
  }

  async function saveSchedule(doc) {
    await ensureDir(core.root);
    await writeJsonAtomic(core.paths.schedule, doc);
  }

  async function tick(reason) {
    const now = Date.now();
    // 1. liveness pulse — always, even when nothing is scheduled.
    try {
      await core.heartbeat(`tick (${reason}) schedules armed`);
    } catch {
      /* heartbeat must never kill the fiber */
    }

    // 2. fire due schedules into the inbox.
    try {
      const doc = await loadSchedule();
      let changed = false;
      const survivors = [];
      for (const item of doc.items) {
        const nextAt = typeof item.nextAt === 'string' ? Date.parse(item.nextAt) : Number.NaN;
        const due = !Number.isNaN(nextAt) && nextAt <= now && item.done !== true;
        if (!due) {
          survivors.push(item);
          continue;
        }
        const fired = (typeof item.fired === 'number' ? item.fired : 0) + 1;
        await core.inboxAppend({
          kind: 'schedule',
          id: item.id,
          name: item.name,
          task: item.task,
          fired: fired,
          catchUp: reason === 'boot',
        });
        await core.journal({ kind: 'schedule-fired', id: item.id, name: item.name, fired, via: reason });
        if (item.kind === 'every') {
          // Anchor the next firing to now; a pile-up of missed intervals is
          // one firing, not one per missed beat.
          survivors.push({ ...item, fired, nextAt: new Date(now + item.everySeconds * 1000).toISOString() });
        } else {
          await core.journal({ kind: 'schedule-done', id: item.id, name: item.name });
        }
        changed = true;
      }
      if (changed) await saveSchedule({ version: 1, items: survivors });
    } catch (error) {
      await core
        .heartbeat(`tick error: ${error && error.message ? error.message : String(error)}`)
        .catch(() => {});
    }

    // 3. refresh the status the model sees.
    await core.refreshStatus().catch(() => {});
  }

  // Arm the one driving timer; Cordis disposes it with the fiber.
  ctx.interval(() => {
    void tick('beat');
  }, heartbeatSeconds * 1000);

  // Boot restore: re-arm persisted schedules, fire what expired while the
  // process was down, write the first pulse immediately so operators see the
  // dot wake up.
  void (async () => {
    try {
      const doc = await loadSchedule();
      const now = Date.now();
      let changed = false;
      for (const item of doc.items) {
        if (typeof item.nextAt !== 'string' || Number.isNaN(Date.parse(item.nextAt))) {
          item.nextAt =
            item.kind === 'every'
              ? new Date(now + item.everySeconds * 1000).toISOString()
              : item.at;
          changed = true;
        }
      }
      if (changed) await saveSchedule(doc);
      await core.journal({ kind: 'boot', plugin: 'dot-scheduler', schedules: doc.items.length, heartbeatSeconds });
    } finally {
      await tick('boot');
    }
  })();

  ctx.provide('dotScheduler', {
    async add(item) {
      const doc = await loadSchedule();
      const normalized = normalize(item);
      if (normalized === null) return { ok: false, error: 'invalid schedule item' };
      doc.items.push(normalized);
      await saveSchedule(doc);
      return { ok: true, id: normalized.id };
    },
    async list() {
      return (await loadSchedule()).items;
    },
    async remove(id) {
      const doc = await loadSchedule();
      const before = doc.items.length;
      doc.items = doc.items.filter((item) => item.id !== id && item.name !== id);
      if (doc.items.length !== before) {
        await saveSchedule(doc);
        return true;
      }
      return false;
    },
    heartbeatSeconds,
  });

  ctx.tools.register(
    dotTool({
      name: 'dot_schedule',
      description:
        'Manage the dot’s durable wakeups. Schedules survive restarts; when one fires it lands in .dot/inbox.jsonl and the dot acts on its task text during the next goal round. Use for "check X every N minutes" and "remind me at T" work.',
      properties: {
        action: { type: 'string', enum: ['add-every', 'add-at', 'list', 'remove'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'Human-readable schedule name (required for add-*).' },
        everySeconds: { type: 'number', description: 'Interval in seconds, minimum 5 (required for add-every).' },
        at: { type: 'string', description: 'ISO-8601 time for a one-shot wakeup (required for add-at).' },
        task: { type: 'string', description: 'Instruction to yourself when this fires (required for add-*).' },
        id: { type: 'string', description: 'Schedule id or exact name (required for remove).' },
      },
      required: ['action'],
      async execute(args) {
        const scheduler = ctx.dotScheduler;
        switch (args.action) {
          case 'add-every': {
            if (typeof args.name !== 'string' || args.name.trim() === '') return 'name is required';
            if (typeof args.everySeconds !== 'number' || args.everySeconds < 5) return 'everySeconds must be a number >= 5';
            if (typeof args.task !== 'string' || args.task.trim() === '') return 'task is required';
            const result = await scheduler.add({
              id: newId(),
              kind: 'every',
              name: args.name.trim(),
              everySeconds: Math.floor(args.everySeconds),
              task: args.task.trim(),
              fired: 0,
              nextAt: new Date(Date.now() + Math.floor(args.everySeconds) * 1000).toISOString(),
            });
            return result.ok ? `scheduled "${args.name}" every ${Math.floor(args.everySeconds)}s (id ${result.id})` : `failed: ${result.error}`;
          }
          case 'add-at': {
            if (typeof args.name !== 'string' || args.name.trim() === '') return 'name is required';
            if (typeof args.at !== 'string' || Number.isNaN(Date.parse(args.at))) return 'at must be an ISO-8601 timestamp';
            if (typeof args.task !== 'string' || args.task.trim() === '') return 'task is required';
            const result = await scheduler.add({
              id: newId(),
              kind: 'at',
              name: args.name.trim(),
              at: new Date(Date.parse(args.at)).toISOString(),
              nextAt: new Date(Date.parse(args.at)).toISOString(),
              task: args.task.trim(),
              fired: 0,
            });
            return result.ok ? `scheduled "${args.name}" at ${args.at} (id ${result.id})` : `failed: ${result.error}`;
          }
          case 'list': {
            const items = await scheduler.list();
            if (items.length === 0) return '(no schedules)';
            return items
              .map((item) =>
                item.kind === 'every'
                  ? `${item.id} · "${item.name}" · every ${item.everySeconds}s · next ${item.nextAt} · fired ${item.fired ?? 0}× · task: ${item.task}`
                  : `${item.id} · "${item.name}" · at ${item.at} · fired ${item.fired ?? 0}× · task: ${item.task}`,
              )
              .join('\n');
          }
          case 'remove': {
            if (typeof args.id !== 'string') return 'id (or exact name) is required';
            return (await scheduler.remove(args.id)) ? `removed ${args.id}` : `not found: ${args.id}`;
          }
          default:
            return `unknown action: ${String(args.action)}`;
        }
      },
    }),
  );
}
