/**
 * dotrules — the dot's autonomy-rule engine, pure and testable.
 *
 * dot-policy.js is the cordis shell (guard hook, prompt section, tool); this
 * module is the decision logic, with no I/O and no cordis imports, so unit
 * tests drive it directly.
 *
 * policy.json shape:
 *   { "mode": "advisory" | "enforce", "allow": [...], "ask": [...], "deny": [...] }
 *
 * Pattern syntax: "name" exact, "prefix*" prefix, "*" everything.
 * Precedence is always deny > ask > allow; unmatched tools fall back to the
 * allow list, which sanitize() guarantees is never empty.
 */

export const DEFAULT_POLICY = Object.freeze({ mode: 'advisory', allow: ['*'], ask: [], deny: [] });

export function matchPattern(name, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

export function matchAny(name, patterns) {
  if (!Array.isArray(patterns)) return undefined;
  return patterns.find((pattern) => typeof pattern === 'string' && matchPattern(name, pattern));
}

export function decide(policy, toolName) {
  const denied = matchAny(toolName, policy.deny);
  if (denied !== undefined) return { level: 'deny', rule: denied };
  const asked = matchAny(toolName, policy.ask);
  if (asked !== undefined) return { level: 'ask', rule: asked };
  const allowed = matchAny(toolName, policy.allow);
  if (allowed !== undefined) return { level: 'allow', rule: allowed };
  return { level: 'allow', rule: '(default)' };
}

/**
 * Coerce raw policy.json content into a safe policy. Anything invalid falls
 * back to the permissive advisory default and reports valid: false — a broken
 * rules file must never silently tighten access (deny-by-default locks the
 * dot out of its own repair loop; dot_* tools are ungated, but the operator's
 * visibility into the invalid state matters more than a fail-closed guess).
 */
export function sanitize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { policy: { ...DEFAULT_POLICY }, valid: false };
  const policy = {
    mode: raw.mode === 'enforce' ? 'enforce' : 'advisory',
    note: typeof raw.note === 'string' ? raw.note : undefined,
    allow: Array.isArray(raw.allow) ? raw.allow.filter((x) => typeof x === 'string') : ['*'],
    ask: Array.isArray(raw.ask) ? raw.ask.filter((x) => typeof x === 'string') : [],
    deny: Array.isArray(raw.deny) ? raw.deny.filter((x) => typeof x === 'string') : [],
  };
  if (policy.allow.length === 0) policy.allow = ['*'];
  return { policy, valid: true };
}
