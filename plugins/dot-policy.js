/**
 * dot-policy — the dot's autonomy rules, enforced.
 *
 * policy.json shape:
 *
 *   {
 *     "mode": "advisory" | "enforce",
 *     "allow": ["*"],          // patterns, first principles order
 *     "ask":   ["bash", "write", "edit"],
 *     "deny":  []
 *   }
 *
 * Pattern syntax: "name" exact, "prefix*" prefix, "*" everything.
 * Precedence is always deny > ask > allow. Unmatched tools fall back to the
 * allow list, which defaults to ["*"].
 *
 * Modes:
 *   advisory — rules are prompt guidance only; the hard `deny` list still
 *              gates execution. Good default while tuning.
 *   enforce  — ask and deny both gate execution through a tools.guard()
 *              hook. An `ask` call is denied with instructions: confirm with
 *              the operator in chat, then grant one execution through
 *              dot_policy {action:"allow-once"}. Once-tokens are in-memory
 *              on purpose: they expire with the fiber, never with the file.
 *
 * The guard never touches tools named dot_* — a dot must always be able to
 * reason about and repair its own policy.
 */
import { readJson, nowIso } from './lib/dotstore.js';
import { DEFAULT_POLICY, decide, sanitize } from './lib/dotrules.js';
import { dotTool } from './lib/dottool.js';

export const name = 'dot-policy';
export const inject = ['dotCore', 'tools', 'systemPrompt'];

export function apply(ctx) {
  const core = ctx.dotCore;

  // Synchronous view of policy.json; refreshed on boot and on demand. The
  // guard and the prompt section both read only this cache.
  let cached = { ...DEFAULT_POLICY };
  let valid = true;
  // In-memory once-tokens: tool name -> remaining grants.
  const once = new Map();

  async function reload() {
    const { policy, valid: ok } = sanitize(await readJson(core.paths.policy, null));
    cached = policy;
    valid = ok;
    return cached;
  }

  function grantOnce(toolName) {
    once.set(toolName, (once.get(toolName) ?? 0) + 1);
  }

  function consumeOnce(toolName) {
    const remaining = once.get(toolName) ?? 0;
    if (remaining <= 0) return false;
    if (remaining === 1) once.delete(toolName);
    else once.set(toolName, remaining - 1);
    return true;
  }

  // Prime the cache; failures leave the safe default in place.
  void reload()
    .then(() => core.journal({ kind: 'boot', plugin: 'dot-policy', mode: cached.mode, policyValid: valid }))
    .then(() => core.refreshStatus())
    .catch(() => {});

  // The enforcement hook. Registered unconditionally; effect depends on mode.
  ctx.tools.guard((execution) => {
    try {
      const toolName = execution.name;
      if (typeof toolName !== 'string') return undefined;
      if (toolName.startsWith('dot_')) return undefined;
      const decision = decide(cached, toolName);
      if (decision.level === 'deny') {
        return (
          `dot policy[deny] matched "${decision.rule}": tool "${toolName}" is forbidden for this dot. ` +
          'Do not retry it; explain the block to the operator and propose a policy change or an alternative.'
        );
      }
      if (cached.mode !== 'enforce') return undefined;
      if (decision.level === 'ask') {
        if (consumeOnce(toolName)) {
          void core.journal({ kind: 'policy-once-consumed', tool: toolName });
          return undefined;
        }
        return (
          `dot policy[ask] matched "${decision.rule}": "${toolName}" requires explicit operator confirmation. ` +
          'Ask the operator in chat; if they approve, call dot_policy {action:"allow-once", tool:"' +
          toolName +
          '"} and then retry the call once.'
        );
      }
      return undefined;
    } catch (error) {
      // Infrastructure failure inside the guard: never brick the session.
      void core
        .heartbeat(`policy guard error (allowing): ${error && error.message ? error.message : String(error)}`)
        .catch(() => {});
      return undefined;
    }
  });

  // The rules, in front of the model on every step.
  ctx.systemPrompt.section({
    name: 'dot.policy',
    order: 610,
    text: () => {
      const oncePending = [...once.entries()].map(([tool, n]) => `${tool}×${n}`).join(', ');
      return [
        `Dot policy (mode: ${cached.mode}${valid ? '' : ' — policy.json invalid, defaults in force'}).`,
        `allow: ${cached.allow.join(' ')} · ask: ${cached.ask.length > 0 ? cached.ask.join(' ') : '(none)'} · deny: ${cached.deny.length > 0 ? cached.deny.join(' ') : '(none)'}`,
        cached.mode === 'enforce'
          ? 'Ask-listed tools are blocked until the operator confirms in chat and you grant one execution via dot_policy allow-once. Deny-listed tools are never runnable. Do not attempt workarounds; negotiate the policy, not the guard.'
          : 'Policy is advisory: treat ask-listed tools as needing explicit operator confirmation and deny-listed tools as forbidden. Switch "mode" to "enforce" in policy.json to make the guard block them.',
        oncePending.length > 0 ? `pending one-time grants: ${oncePending}` : null,
        cached.note !== undefined ? `operator note: ${cached.note}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  ctx.provide('dotPolicy', {
    load: reload,
    decide: (toolName) => decide(cached, toolName),
    mode: () => cached.mode,
    grantOnce,
    consumeOnce,
  });

  ctx.tools.register(
    dotTool({
      name: 'dot_policy',
      description:
        'View the dot’s autonomy policy, re-read it from policy.json after edits, or grant one execution of an ask-listed tool after the operator confirmed in chat. Policy text itself is edited in .dot/policy.json, not through this tool.',
      properties: {
        action: { type: 'string', enum: ['view', 'reload', 'allow-once'], description: 'Operation to perform.' },
        tool: { type: 'string', description: 'Tool name (required for allow-once).' },
      },
      required: ['action'],
      async execute(args) {
        switch (args.action) {
          case 'view': {
            const oncePending = [...once.entries()].map(([tool, n]) => `${tool}×${n}`).join(', ');
            return [
              `mode: ${cached.mode} (file ${valid ? 'valid' : 'INVALID — defaults in force'})`,
              `allow: ${cached.allow.join(', ') || '(none)'}`,
              `ask:   ${cached.ask.join(', ') || '(none)'}`,
              `deny:  ${cached.deny.join(', ') || '(none)'}`,
              oncePending ? `one-time grants pending: ${oncePending}` : 'no pending one-time grants',
              `policy file: ${core.paths.policy}`,
            ].join('\n');
          }
          case 'reload': {
            await reload();
            await core.journal({ kind: 'policy-reload', mode: cached.mode, valid });
            await core.refreshStatus().catch(() => {});
            return `reloaded: mode=${cached.mode}${valid ? '' : ' (file invalid — defaults in force)'}`;
          }
          case 'allow-once': {
            if (typeof args.tool !== 'string' || args.tool.trim() === '') return 'tool is required';
            if (args.tool.startsWith('dot_')) return `dot_* tools are never gated; nothing to grant`;
            grantOnce(args.tool.trim());
            await core.journal({ kind: 'policy-once-granted', tool: args.tool.trim(), at: nowIso() });
            return cached.mode === 'enforce'
              ? `granted one execution of "${args.tool.trim()}". Retry the call now.`
              : `granted one execution of "${args.tool.trim()}" (policy is advisory, so the guard is not blocking it anyway).`;
          }
          default:
            return `unknown action: ${String(args.action)}`;
        }
      },
    }),
  );
}
