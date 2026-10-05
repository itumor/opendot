/**
 * dot-memory — the dot's long-term notes.
 *
 * memory.md is an append-only markdown file of one-line facts the dot chose
 * to retain, plus an audit copy in journal.jsonl. The dot writes to it
 * deliberately (via dot_remember), reads it back via dot_recall, and any
 * human can read or edit it directly — memory you can inspect is memory you
 * can trust.
 *
 * Recall is deliberately simple: case-insensitive substring match, newest
 * first. A vector store is a v0.3 concern; for a personal dot, "did I write
 * this down?" beats "what is semantically adjacent?".
 */
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
const { readText, nowIso } = await import(fresh('./lib/dotstore.js'));
const { dotTool } = await import(fresh('./lib/dottool.js'));

export const name = 'dot-memory';
export const inject = ['dotCore', 'tools'];

export function apply(ctx) {
  const core = ctx.dotCore;

  async function remember(fact, tags) {
    const stamp = nowIso();
    const cleanTags = Array.isArray(tags)
      ? tags.map((t) => String(t).replace(/[^\w-]/gu, '')).filter(Boolean).slice(0, 8)
      : [];
    const tagSuffix = cleanTags.length > 0 ? ' ' + cleanTags.map((t) => `#${t}`).join(' ') : '';
    const line = `- [${stamp}] ${fact}${tagSuffix}`;
    await appendFile(core.paths.memory, line + '\n', 'utf8');
    await core.journal({ kind: 'memory-write', fact: fact.slice(0, 300), tags: cleanTags });
    return line;
  }

  async function recall(query, limit) {
    const text = await readText(core.paths.memory, '');
    const lines = text.split('\n').filter((line) => line.startsWith('- ['));
    if (typeof query !== 'string' || query.trim() === '') {
      return lines.slice(-limit).reverse();
    }
    const needle = query.trim().toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(needle)).slice(-limit).reverse();
  }

  ctx.provide('dotMemory', { remember, recall });

  ctx.tools.register(
    dotTool({
      name: 'dot_remember',
      description:
        'Store one fact in the dot’s long-term memory (memory.md) — durable across context compaction and restarts. Write things you will need later: decisions, operator preferences, environment facts, lessons learned. One line, one fact; add tags to find it again.',
      properties: {
        fact: { type: 'string', description: 'The fact to store, one line. Include the why, not just the what.' },
        tags: { type: 'array', description: 'Optional short tags (e.g. ["castai", "prod"]); each becomes a #tag.', items: { type: 'string' } },
      },
      required: ['fact'],
      async execute(args) {
        if (typeof args.fact !== 'string' || args.fact.trim() === '') return 'fact is required';
        const line = await remember(args.fact.trim().replace(/\s+/g, ' '), args.tags);
        return `remembered: ${line}`;
      },
    }),
  );

  ctx.tools.register(
    dotTool({
      name: 'dot_recall',
      description:
        'Search the dot’s long-term memory. Substring match over memory.md, newest first. Call without a query for the most recent facts. Read memory before answering questions about past decisions or preferences.',
      properties: {
        query: { type: 'string', description: 'Text to search for (omit for recent facts).' },
        limit: { type: 'number', description: 'Max facts to return (default 10, max 50).' },
      },
      async execute(args) {
        const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, Math.floor(args.limit)), 50) : 10;
        const hits = await recall(typeof args.query === 'string' ? args.query : undefined, limit);
        if (hits.length === 0) return args.query ? `no memory matches "${args.query}"` : '(memory is empty)';
        return hits.join('\n');
      },
    }),
  );
}
