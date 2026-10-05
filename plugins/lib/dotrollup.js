/**
 * dotrollup — the daily status.md: yesterday's dot, one page, no model call.
 *
 * The live /dot/status dashboard answers "what is the dot doing NOW"; this
 * lib answers "what did the dot DO on day D" from the files that already
 * exist — journal.jsonl, inbox.done.jsonl, rounds.log, heartbeat.log — and
 * the organ (dot-report) writes the answer to status/YYYY-MM-DD.md. All
 * aggregation is deterministic templating: a rollup must be right at 4am
 * with no model awake, and identical inputs must give identical markdown.
 *
 * Inputs are LINE LISTS and TEXT, never paths — the organ does the I/O so
 * every function here stays pure and cheap to test. Any input may be absent;
 * the page reports "(none)" or omits a section rather than failing — a day
 * with no rounds is still a day.
 */
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_LINE_START = /^(\d{4}-\d{2}-\d{2})T?\d{2}:\d{2}/;

/** Validate (or derive) a YYYY-MM-DD day key. Returns null for junk. */
export function normalizeDay(value) {
  return typeof value === 'string' && DAY_SHAPE.test(value.trim()) ? value.trim() : null;
}

/** Yesterday's UTC day key — the default rollup target. */
export function yesterdayDay(nowMs = Date.now()) {
  return new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
}

/** The YYYY-MM-DD of an ISO-8601 timestamp, else null. */
export function dayOf(iso) {
  if (typeof iso !== 'string') return null;
  const match = ISO_LINE_START.exec(iso.trim());
  return match ? match[1] : null;
}

/** Journal/inbox items whose `at` falls on `day`. */
export function entriesForDay(entries, day) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => dayOf(entry?.at) === day);
}

/** Inbox-done items whose `drainedAt` falls on `day`. */
export function drainedForDay(entries, day) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => dayOf(entry?.drainedAt ?? entry?.at) === day);
}

/** Log lines (rounds.log, heartbeat.log) stamped with `day`, clipped whole lines. */
export function linesForDay(text, day) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '' && dayOf(line.trim()) === day);
}

/** kind → count map for a list of entries, sorted by count desc then name. */
export function kindCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const kind = typeof entry?.kind === 'string' && entry.kind !== '' ? entry.kind : '(untyped)';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Every UTC day from the first day with evidence through `throughDay`
 * inclusive — the "days the dot was alive" backfill set. Evidence is journal
 * `at` stamps and heartbeat-line prefixes; days with neither simply cannot
 * be told from days the host was down, and both get a page.
 */
export function aliveDays({ journal = [], heartbeat = '', rounds = '' } = {}, throughDay) {
  const days = new Set();
  for (const entry of journal) {
    const day = dayOf(entry?.at);
    if (day !== null) days.add(day);
  }
  for (const line of String(heartbeat).split('\n')) {
    const day = dayOf(line.trim());
    if (day !== null) days.add(day);
  }
  for (const line of String(rounds).split('\n')) {
    const day = dayOf(line.trim());
    if (day !== null) days.add(day);
  }
  if (days.size === 0) return [];
  const first = [...days].sort()[0];
  const last = normalizeDay(throughDay) ?? [...days].sort().at(-1);
  const out = [];
  for (let ms = Date.parse(first); ms <= Date.parse(last); ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const clip = (value, max = 220) => {
  const text = cell(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * Build the markdown page for one day. `sources`: { journal, inboxDone,
 * rounds (text), heartbeat (text) } — each optional; `date` is the day key;
 * `generatedAt` stamps the footer (tests pin it).
 */
export function buildRollup({ date, sources = {}, generatedAt = new Date().toISOString() }) {
  const journal = entriesForDay(sources.journal, date);
  const drained = drainedForDay(sources.inboxDone, date);
  const heartbeats = linesForDay(sources.heartbeat, date);
  const rounds = linesForDay(sources.rounds, date);

  // ── anomalies: the lines a human would hunt for ────────────────────────
  const anomalies = [];
  for (const entry of journal) {
    if (entry.kind === 'event-route-conflict') {
      anomalies.push(`route conflict: \`${cell(entry.path)}\` — ${clip(entry.error, 140)}`);
    } else if (entry.kind === 'boot') {
      anomalies.push(`restart: ${cell(entry.plugin)} booted at ${cell(entry.at)}`);
    } else if (typeof entry.lastWriteError === 'string' && entry.lastWriteError !== '') {
      anomalies.push(`${cell(entry.kind)}: write error — ${clip(entry.lastWriteError, 140)}`);
    }
  }
  for (const line of heartbeats.filter((l) => /error|fail/i.test(l)).slice(0, 5)) {
    anomalies.push(`heartbeat: ${clip(line, 160)}`);
  }
  for (const line of rounds.filter((l) => /error|fail|blocked/i.test(l)).slice(0, 5)) {
    anomalies.push(`round: ${clip(line, 160)}`);
  }

  // ── schedules: what fired, grouped by name ─────────────────────────────
  const fired = journal.filter((entry) => entry.kind === 'schedule-fired');
  const firedByName = new Map();
  for (const entry of fired) {
    const key = cell(entry.name ?? entry.id ?? '(unnamed)');
    firedByName.set(key, (firedByName.get(key) ?? 0) + 1);
  }

  // ── inbox: what the loop drained, by kind, with a sample of messages ───
  const drainedSample = drained
    .slice()
    .reverse()
    .slice(0, 8)
    .map((entry) => `- ${cell(entry.kind ?? 'item')}${entry.name ? ` \`${cell(entry.name)}\`` : ''}: ${clip(entry.message ?? entry.task ?? '', 140)}`);

  const out = [];
  out.push(`# dot status — ${date}`);
  out.push('');
  out.push('## pulse');
  out.push('');
  if (heartbeats.length === 0) {
    out.push('- no heartbeats recorded — the dot (or its host) was down this day');
  } else {
    out.push(`- ${heartbeats.length} heartbeats · first ${cell(heartbeats[0].slice(0, 19))} · last ${cell(heartbeats.at(-1).slice(0, 19))}`);
  }
  out.push(`- journal events: ${journal.length} · inbox items drained: ${drained.length} · goal rounds: ${rounds.length}`);
  out.push('');
  if (rounds.length > 0) {
    out.push('## rounds');
    out.push('');
    for (const line of rounds) out.push(`- ${clip(line, 220)}`);
    out.push('');
  }
  out.push('## journal by kind');
  out.push('');
  const counts = kindCounts(journal);
  if (counts.length === 0) {
    out.push('(none)');
  } else {
    out.push('| kind | count |', '|---|---|');
    for (const [kind, count] of counts) out.push(`| ${kind} | ${count} |`);
  }
  out.push('');
  if (firedByName.size > 0) {
    out.push('## schedules fired');
    out.push('');
    for (const [name, count] of [...firedByName.entries()].sort()) out.push(`- ${name} — ${count}×`);
    out.push('');
  }
  if (drainedSample.length > 0) {
    out.push('## inbox drained (recent first)');
    out.push('');
    out.push(...drainedSample);
    out.push('');
  }
  out.push('## anomalies');
  out.push('');
  if (anomalies.length === 0) out.push('(none)');
  else for (const anomaly of anomalies) out.push(`- ${anomaly}`);
  out.push('');
  out.push(`_generated ${generatedAt} from journal.jsonl · inbox.done.jsonl · rounds.log · heartbeat.log_`);
  out.push('');
  return out.join('\n');
}
