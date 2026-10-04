/**
 * dotprefs — pure helpers for dot-profile: preference-file parsing and
 * feedback-entry shaping. No I/O, no cordis — unit tests drive these.
 */

/**
 * Bullet lines (`- ...`) under a `## <heading>` section of a markdown doc,
 * up to the next `## ` heading or EOF. Heading match is exact and
 * case-insensitive. Absent section → empty list (never an error).
 */
export function parseBullets(markdown, heading) {
  if (typeof markdown !== 'string' || typeof heading !== 'string') return [];
  const wanted = heading.trim().toLowerCase();
  const lines = markdown.split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (sectionMatch !== null) {
      inside = sectionMatch[1].toLowerCase() === wanted;
      continue;
    }
    if (inside && line.startsWith('- ')) out.push(line.slice(2).trim());
  }
  return out.filter((line) => line !== '' && !line.startsWith('(none'));
}

/** Glyph for a feedback signal, so the log scans: (+) good, (-) bad, (~) neutral. */
export function signalGlyph(signal) {
  if (signal === 'positive') return '+';
  if (signal === 'negative') return '-';
  return '~';
}

export function normalizeSignal(signal) {
  return signal === 'positive' || signal === 'negative' ? signal : 'neutral';
}

/** One append-only feedback-log line. `- [ISO] (+) note  [context: …]` */
export function formatFeedback({ signal, note, context, at }) {
  const glyph = signalGlyph(signal);
  const when = typeof at === 'string' ? at : new Date().toISOString();
  const ctxPart = typeof context === 'string' && context.trim() !== '' ? `  [context: ${context.trim().slice(0, 200)}]` : '';
  return `- [${when}] (${glyph}) ${note.trim().replace(/\s+/g, ' ')}${ctxPart}`;
}
