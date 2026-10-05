/**
 * dot-profile — the dot's identity and its model of the operator.
 *
 * OpenAI's dots start by getting a name and grow by learning what good looks
 * like. This plugin is that, in files:
 *
 *   profile.json     { name, tagline, operator } — who this dot is, and who
 *                    it serves. Operator-editable; the dot reads it into the
 *                    prompt every step via the dot.profile section.
 *   preferences.md   two-part learning log: a curated TOP section of stable
 *                    operator preferences (the dot edits it only when a
 *                    pattern repeats), and a `## feedback log` LAST section
 *                    where dot_feedback appends raw (+)/(−)/(~) signals.
 *                    Keeping the log last is load-bearing: appends must land
 *                    in it.
 *
 * The section renderer reads a cache, not the files (prompt providers are
 * synchronous). The cache refreshes on boot and after every write the plugin
 * makes — edits made by hand in an editor surface on the next tool call or
 * remount, and `dot_profile {action:"reload"}` forces it.
 */
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { statSync } from 'node:fs';

// Cache-proof repo-internal imports — see the header of dot-core.js for why
// the mtime stamp is load-bearing (stale per-URL module cache across preset
// remounts). Keep every './lib/…' specifier behind fresh().
const fresh = (rel) => {
  const url = new URL(rel, import.meta.url);
  url.search = `?mtime=${statSync(url).mtimeMs}`;
  return url.href;
};
const { ensureDir, readJson, readText, nowIso } = await import(fresh('./lib/dotstore.js'));
const { parseBullets, formatFeedback, normalizeSignal } = await import(fresh('./lib/dotprefs.js'));
const { dotTool } = await import(fresh('./lib/dottool.js'));

export const name = 'dot-profile';
export const inject = ['dotCore', 'tools', 'systemPrompt'];

const PROFILE_SEED = { name: 'Dot', tagline: 'always-on personal agent', operator: '' };

const PREFERENCES_SEED = `# Operator preferences

What the operator has taught this dot about how they want work done. The
curated section holds stable, repeated preferences — the dot distils feedback
into it conservatively (a preference enters curated only after the pattern
shows up more than once). Raw signals accumulate in the feedback log.

## curated

(none yet — distilled from the feedback log below as patterns emerge)

## feedback log

`;

export function apply(ctx) {
  const core = ctx.dotCore;
  const profilePath = join(core.root, 'profile.json');
  const prefsPath = join(core.root, 'preferences.md');

  // Prompt-side cache: see the module header for why files aren't read live.
  let cache = { name: 'Dot', tagline: '', operator: '', curated: [], recentFeedback: [] };

  async function refresh() {
    try {
      const [profile, prefs] = await Promise.all([readJson(profilePath, PROFILE_SEED), readText(prefsPath, '')]);
      const curated = parseBullets(prefs, 'curated');
      const feedback = parseBullets(prefs, 'feedback log');
      cache = {
        name: typeof profile.name === 'string' && profile.name.trim() !== '' ? profile.name.trim() : 'Dot',
        tagline: typeof profile.tagline === 'string' ? profile.tagline.trim() : '',
        operator: typeof profile.operator === 'string' ? profile.operator.trim() : '',
        curated: curated.slice(0, 6),
        recentFeedback: feedback.slice(-3),
      };
    } catch {
      /* a broken profile must never blank the prompt — keep the last good cache */
    }
    return cache;
  }

  // Boot: seed absent files, then prime the cache.
  void (async () => {
    try {
      await ensureDir(core.root);
      if ((await readText(profilePath, null)) === null) {
        await appendFile(profilePath, JSON.stringify(PROFILE_SEED, null, 2) + '\n', 'utf8');
      }
      if ((await readText(prefsPath, null)) === null) {
        await appendFile(prefsPath, PREFERENCES_SEED, 'utf8');
      }
      await refresh();
      await core.journal({ kind: 'boot', plugin: 'dot-profile', name: cache.name });
    } catch (error) {
      await core
        .journal({ kind: 'boot-error', plugin: 'dot-profile', error: String(error && error.message ? error.message : error) })
        .catch(() => {});
    }
  })();

  // The identity and the operator model, in front of the model on every step.
  ctx.systemPrompt.section({
    name: 'dot.profile',
    order: 135,
    text: () => {
      const lines = [`You are ${cache.name}${cache.tagline !== '' ? ` — ${cache.tagline}` : ''}.`];
      if (cache.operator !== '') lines.push(`Operator: ${cache.operator}`);
      if (cache.curated.length > 0) {
        lines.push('Operator preferences (learned, curated):');
        for (const pref of cache.curated) lines.push(`- ${pref}`);
      }
      if (cache.recentFeedback.length > 0) {
        lines.push(`Recent feedback: ${cache.recentFeedback.join(' · ')}`);
      }
      lines.push('When the operator reacts to your work, capture it with dot_feedback; distilled preferences belong in preferences.md.');
      return lines.join('\n');
    },
  });

  ctx.provide('dotProfile', {
    refresh,
    view: () => ({ ...cache, curated: [...cache.curated], recentFeedback: [...cache.recentFeedback] }),
  });

  ctx.tools.register(
    dotTool({
      name: 'dot_profile',
      description:
        "View the dot's identity (profile.json) and its model of the operator (curated preferences + recent feedback from preferences.md), or re-read those files after manual edits. Identity edits themselves happen in the files.",
      properties: {
        action: { type: 'string', enum: ['view', 'reload'], description: 'Operation to perform.' },
      },
      required: ['action'],
      async execute(args) {
        switch (args.action) {
          case 'view':
            return [
              `name: ${cache.name}`,
              `tagline: ${cache.tagline || '(none)'}`,
              `operator: ${cache.operator || '(not described yet)'}`,
              `curated preferences: ${cache.curated.length > 0 ? '\n- ' + cache.curated.join('\n- ') : '(none yet)'}`,
              `recent feedback: ${cache.recentFeedback.length > 0 ? '\n- ' + cache.recentFeedback.join('\n- ') : '(none yet)'}`,
              `files: ${profilePath} · ${prefsPath}`,
            ].join('\n');
          case 'reload': {
            const fresh = await refresh();
            return `reloaded identity: ${fresh.name} — ${fresh.curated.length} curated preferences, ${fresh.recentFeedback.length} recent feedback entries`;
          }
          default:
            return `unknown action: ${String(args.action)}`;
        }
      },
    }),
  );

  ctx.tools.register(
    dotTool({
      name: 'dot_feedback',
      description:
        "Capture one piece of operator feedback about your work — what was good, what missed, and why. Appends a one-line (+)/(−)/(~) signal to preferences.md's feedback log; when a pattern repeats, distil it into the curated section by editing preferences.md directly. Feedback you record is how you learn what good looks like.",
      properties: {
        signal: { type: 'string', enum: ['positive', 'negative', 'neutral'], description: 'How the work landed.' },
        note: { type: 'string', description: 'One line: what the feedback was. Include the why, not just the what.' },
        context: { type: 'string', description: 'Optional: which piece of work this refers to.' },
      },
      required: ['signal', 'note'],
      async execute(args) {
        if (typeof args.note !== 'string' || args.note.trim() === '') return 'note is required';
        const signal = normalizeSignal(args.signal);
        const line = formatFeedback({ signal, note: args.note, context: args.context, at: nowIso() });
        await ensureDir(core.root);
        await appendFile(prefsPath, line + '\n', 'utf8');
        await core.journal({ kind: 'feedback', signal, note: args.note.trim().slice(0, 200) });
        await refresh();
        return `feedback recorded: ${line}`;
      },
    }),
  );
}
