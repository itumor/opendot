/**
 * dot-report — the archival layer under the live /dot/status dashboard:
 * one status/YYYY-MM-DD.md per day the dot was alive.
 *
 * The /dot/status page answers "what is the dot doing NOW"; this organ
 * answers "what did the dot DO on day D", deterministically — the build is
 * pure templating (lib/dotrollup.js) over journal.jsonl, inbox.done.jsonl,
 * rounds.log and heartbeat.log, so the page comes out right at 4am with no
 * model awake and identical inputs give identical markdown. Every write also
 * links the page from tasks.md so the operator walks in on a table of
 * contents, not a pile of dated files.
 *
 * The daily cadence is a dot_schedule entry, per the standing convention:
 * the scheduler never calls a model, it fires into the inbox; the goal loop
 * drains that item and calls dot_report write (default: yesterday). Misses
 * self-heal — `backfill` writes every alive day with no page yet.
 */
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';

// Cache-proof repo-internal imports — see the header of dot-core.js for why
// the mtime stamp is load-bearing (stale per-URL module cache across preset
// remounts). Keep every './lib/…' specifier behind fresh().
const fresh = (rel) => {
  const url = new URL(rel, import.meta.url);
  url.search = `?mtime=${statSync(url).mtimeMs}`;
  return url.href;
};
const { ensureDir, readJsonLines, readText, writeTextAtomic, nowIso } = await import(fresh('./lib/dotstore.js'));
const { buildRollup, aliveDays, normalizeDay, yesterdayDay } = await import(fresh('./lib/dotrollup.js'));
const { dotTool } = await import(fresh('./lib/dottool.js'));

export const name = 'dot-report';
export const inject = ['dotCore', 'tools'];

export function apply(ctx) {
  const core = ctx.dotCore;
  const statusDir = join(core.root, 'status');

  async function gatherSources() {
    const [journal, inboxDone, rounds, heartbeat] = await Promise.all([
      readJsonLines(core.paths.journal),
      readJsonLines(core.paths.inboxDone),
      readText(join(core.root, 'rounds.log'), ''),
      readText(core.paths.heartbeat, ''),
    ]);
    return { journal, inboxDone, rounds, heartbeat };
  }

  async function linkFromTasks(date) {
    const link = `- [status ${date}](status/${date}.md)`;
    const path = join(core.root, 'tasks.md');
    const text = await readText(path, null);
    if (text === null || text.includes(`status/${date}.md`)) return false;
    const section = /^## status reports\s*$/m.test(text)
      ? text.replace(/^(## status reports\s*)$/m, `$1\n${link}`)
      : `${text.trimEnd()}\n\n## status reports\n\n${link}\n`;
    await writeTextAtomic(path, section.endsWith('\n') ? section : section + '\n');
    return true;
  }

  async function existingPages() {
    try {
      return (await readdir(statusDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort();
    } catch {
      return [];
    }
  }

  async function writeDay(date) {
    const day = normalizeDay(date) ?? yesterdayDay();
    const sources = await gatherSources();
    const markdown = buildRollup({ date: day, sources });
    await ensureDir(statusDir);
    await writeTextAtomic(join(statusDir, `${day}.md`), markdown);
    const linked = await linkFromTasks(day).catch(() => false);
    await core.journal({ kind: 'rollup-written', date: day, linked });
    return { day, path: join(statusDir, `${day}.md`), linked };
  }

  const report = {
    writeDay,
    /** Write every alive day with no page yet; returns the written days. */
    async backfill() {
      const through = yesterdayDay();
      const have = new Set(await existingPages());
      const written = [];
      for (const day of aliveDays(await gatherSources(), through)) {
        if (have.has(`${day}.md`)) continue;
        await writeDay(day);
        written.push(day);
      }
      return written;
    },
    async list() {
      return (await existingPages()).map((name) => name.replace(/\.md$/, ''));
    },
  };

  ctx.provide('dotReport', report);

  void core.journal({ kind: 'boot', plugin: 'dot-report' });

  ctx.tools.register(
    dotTool({
      name: 'dot_report',
      description:
        'Write the dot’s daily status page (status/YYYY-MM-DD.md): a deterministic rollup of journal + drained inbox + rounds + heartbeats for one day — what the dot did, what fired, anomalies. Default day is yesterday (UTC). The daily schedule fires this; backfill writes every alive day missing its page. Pages link themselves from tasks.md.',
      properties: {
        action: { type: 'string', enum: ['write', 'backfill', 'list'], description: 'Operation to perform.' },
        date: { type: 'string', description: 'Day to write, YYYY-MM-DD (write only; default yesterday UTC).' },
      },
      required: ['action'],
      async execute(args) {
        switch (args.action) {
          case 'write': {
            if (args.date !== undefined && normalizeDay(args.date) === null) return 'date must be YYYY-MM-DD';
            const result = await writeDay(args.date);
            return `wrote ${result.path}${result.linked ? ' (linked from tasks.md)' : ''}`;
          }
          case 'backfill': {
            const days = await report.backfill();
            return days.length === 0 ? 'nothing missing — every alive day has its page' : `wrote ${days.length}: ${days.join(', ')}`;
          }
          case 'list': {
            const days = await report.list();
            return days.length === 0 ? '(no status pages yet)' : days.join('\n');
          }
          default:
            return `unknown action: ${String(args.action)}`;
        }
      },
    }),
  );
}
