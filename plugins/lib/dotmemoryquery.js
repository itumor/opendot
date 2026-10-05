/**
 * dotmemoryquery — ranked recall over memory.md, dependency-free.
 *
 * v0.2 recall was substring-only: one needle, newest first. Dots learn over
 * months, so "did I write this down?" grows into "what did I decide about X
 * and Y?" — a multi-term question a single substring can't answer. This lib
 * keeps retrieval honest without growing a vector store:
 *
 *   - a query is TERMS plus TAG FILTERS: `tag:prod` or `#prod` tokens filter
 *     to lines carrying that #tag; everything else is a word-ish term;
 *   - ranking is COVERAGE FIRST: a line matching every query term beats any
 *     line matching only some, however recent the partial match is;
 *   - recency breaks ties inside the same coverage: a gentle weight in
 *     [0.25, 1] that halves roughly monthly, so a fresher same-coverage line
 *     wins but a fresher partial match never leapfrogs a full one;
 *   - an empty query (or one that parses to nothing) keeps the legacy
     behavior: newest lines first, no scoring.
 *
 * Score shape, for coverage c (fraction of distinct terms matched), term
 * hits h, and recency weight r:  10·c + h + 2·r.  The ×10 on coverage is
 * load-bearing: the wildest h+2r swing is n − 1.5 (n distinct terms, brand
 * new vs ancient), and 10·(1/n) stays ahead of that while n < 20 — far past
 * any honest dot_recall query. Full vector search stays v0.4 optional.
 */
const WORD = /[\p{L}\p{N}_-]+/gu;
const LINE_TAG = /#([\p{L}\p{N}_-]+)/gu;
const STAMP = /^- \[([^\]]+)\]\s*/;

/**
 * Split a free-text query into { terms, tags }. `tag:x` and `#x` tokens
 * become tag filters; every other word-ish token becomes a term. Terms and
 * tags are lowercased and deduped by callers that care (Set at score time).
 */
export function parseRecallQuery(query) {
  const terms = [];
  const tags = [];
  for (const token of String(query ?? '').trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('#') && token.length > 1) {
      const tag = token.slice(1).toLowerCase().replace(/[^\w-]/gu, '');
      if (tag) tags.push(tag);
      continue;
    }
    const tagged = /^tag:(.*)$/iu.exec(token);
    if (tagged) {
      // Consumed as a tag filter even with an empty value — a bare `tag:`
      // is junk, not the word "tag".
      const tag = tagged[1].toLowerCase().replace(/[^\w-]/gu, '');
      if (tag) tags.push(tag);
      continue;
    }
    for (const word of token.toLowerCase().matchAll(WORD)) terms.push(word[0]);
  }
  return { terms, tags };
}

/** #tags carried by one memory line, lowercased. */
export function lineTags(line) {
  const tags = [];
  for (const match of line.matchAll(LINE_TAG)) tags.push(match[1].toLowerCase());
  return tags;
}

/**
 * Gentle age discount in [0.25, 1]: 1 for a line written now, falling as
 * 1/(1 + days/30) — about 0.5 at one month, asymptoting to 0.25 so no fact
 * ever reaches zero on age alone. Undated lines score a neutral 0.6.
 */
export function recencyWeight(line, nowMs = Date.now()) {
  const stamp = STAMP.exec(line);
  const written = stamp ? Date.parse(stamp[1]) : NaN;
  if (Number.isNaN(written)) return 0.6;
  const days = Math.max(0, (nowMs - written) / 86_400_000);
  return 0.25 + 0.75 / (1 + days / 30);
}

/**
 * Score one line against a parsed query. Tags are hard filters (a missing
 * tag zeroes the line); with terms present, matching none also zeroes. The
 * empty-terms/empty-tags query never reaches here — rankRecall short-circuits
 * it to newest-first.
 */
export function scoreRecallLine(line, { terms, tags }, nowMs = Date.now()) {
  const wantedTags = [...new Set(tags)];
  if (wantedTags.length > 0) {
    const have = new Set(lineTags(line));
    for (const tag of wantedTags) if (!have.has(tag)) return 0;
  }
  const wantedTerms = [...new Set(terms)];
  const lower = line.toLowerCase();
  let hits = 0;
  for (const term of wantedTerms) if (lower.includes(term)) hits++;
  if (wantedTerms.length > 0 && hits === 0) return 0;
  const coverage = wantedTerms.length > 0 ? hits / wantedTerms.length : 1;
  return 10 * coverage + hits + 2 * recencyWeight(line, nowMs);
}

/**
 * Rank `memory.md` text against a free-text query. Returns matching lines
 * best-first; ties (identical score) prefer the later file line — memory is
 * append-only, so later is newer. `limit` caps the result (default 10).
 */
export function rankRecall(text, query, { limit = 10, nowMs = Date.now() } = {}) {
  const lines = String(text ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- ['));
  const parsed = parseRecallQuery(query);
  if (parsed.terms.length === 0 && parsed.tags.length === 0) {
    return lines.slice(-limit).reverse();
  }
  return lines
    .map((line, index) => ({ line, index, score: scoreRecallLine(line, parsed, nowMs) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map((entry) => entry.line);
}
