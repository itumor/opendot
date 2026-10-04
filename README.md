# deepseek-dot

**DEEPSEEK DOT** — an always-on personal agent built as plain-JavaScript plugins for DeepSeek Harness (DSH), mounted through the `dot` agent preset.

No build step, no npm install, no fork: the preset references the plugin files directly, so editing a file here changes the dot on its next mount.

## What it is

OpenAI "Dots" are always-running agents: they keep goals, wake on schedules and events, hold long-term memory, and act under operator-set autonomy rules. This repo implements that pattern natively on DSH instead of as a separate runtime:

```
            DeepSeek Harness process
                     │
          dot agent preset (agent.cordis.yml)
                     │
     ┌───────────────┼────────────────┬─────────────┐
     │               │                │             │
 dot-core      dot-scheduler    dot-memory    dot-policy
 state home    heartbeat +      memory.md     policy.json rules
 kv, inbox,    durable wakeups  dot_remember  + tools.guard()
 journal,      (schedule.json)  dot_recall    enforcement
 dot_state     dot_schedule     service       dot_policy
 service                       service       prompt section
```

The always-on loop itself:

```
 timer tick (dot-scheduler)          external trigger (curl, webhook)
        │                                    │
        ▼                                    ▼
 heartbeat.log  +  due schedules ──▶  inbox.jsonl  ◀── you can append by hand
                                            │
                    standing goal (armed)   │  each continuation round:
                                            ▼
                                    drain inbox → act → update tasks.md
                                            │
                                    dot policy check (ask/deny rules)
                                            │
                                    work + dot_remember durable notes
                                            │
                                          sleep
```

The wake path is deliberately *write-only*: the scheduler never calls a model. It writes to `inbox.jsonl`; the agent's standing goal loop (kept armed per the persona) drains the inbox and does the thinking. That keeps tokens spent on work, not on polling.

## Layout

```
plugins/
  lib/dotstore.js   atomic JSON writes, JSONL journals, seeded reads
  lib/dottool.js    shared ToolDefinition builder
  dot-core.js       service dotCore    + tool dot_state     + dot.status prompt context
  dot-scheduler.js  service dotScheduler + tool dot_schedule + heartbeat
  dot-memory.js     service dotMemory  + tools dot_remember / dot_recall
  dot-policy.js     service dotPolicy  + tool dot_policy    + tools.guard enforcement
```

## State home

Everything the dot persists lives as plain files in its home (currently `/Users/eramadan/opendot/.dot`):

| file | owner | contents |
|---|---|---|
| `kv.json` | dot-core | durable key/value state (`dot_state`) |
| `inbox.jsonl` | dot-core | pending triggers; drained → `inbox.done.jsonl` |
| `heartbeat.log` | dot-scheduler | liveness pulse, one line per tick |
| `journal.jsonl` | all | append-only audit spine |
| `memory.md` | dot-memory | long-term notes (`dot_remember`/`dot_recall`) |
| `policy.json` | dot-policy | autonomy rules |
| `schedule.json` | dot-scheduler | durable wakeups |
| `tasks.md` | you + dot | standing tasks (driven by the persona) |

Files are the interface: you can read, edit, or append any of them directly; the dot rebuilds safely from partial state (atomic writes, seen-JSON fallbacks, torn-line-tolerant journals).

## policy.json — autonomy rules

```json
{
  "mode": "advisory",
  "allow": ["*"],
  "ask": [],
  "deny": []
}
```

- Patterns: exact name, `prefix*`, or `*`. Precedence: **deny > ask > allow**.
- `advisory` — rules guide the model through its prompt; the hard `deny` list still blocks execution.
- `enforce` — `ask` tools are blocked with instructions: confirm with the operator in chat, then `dot_policy {action:"allow-once", tool:"<name>"}` and retry once. Grants are in-memory and expire with the run.
- `dot_*` tools are never gated — a dot can't lock itself out of its own policy.

## Mounting

The `dot` preset at `~/.dsh/.agent-presets/dot/agent.cordis.yml` mounts these files via absolute `file://` rows inside one isolated `cordis:group`:

```yaml
- id: dot
  name: cordis:group
  group: true
  isolate:
    dotCore: true
    dotMemory: true
    dotScheduler: true
    dotPolicy: true
  config:
    - id: dot-core
      name: 'file:///Users/eramadan/opendot/deepseek-dot/plugins/dot-core.js'
      config: { root: /Users/eramadan/opendot/.dot }
    - id: dot-scheduler
      name: 'file:///Users/eramadan/opendot/deepseek-dot/plugins/dot-scheduler.js'
      config: { heartbeatSeconds: 60 }
    - id: dot-memory
      name: 'file:///Users/eramadan/opendot/deepseek-dot/plugins/dot-memory.js'
    - id: dot-policy
      name: 'file:///Users/eramadan/opendot/deepseek-dot/plugins/dot-policy.js'
```

Plugin module contract: ESM named exports `name`, optional `inject`, `apply(ctx, config)`; provide services with `ctx.provide(name, value)`; consume with `ctx.get`/`inject`; keep every side effect fiber-owned (timer/registry disposers). Node builtins only — bare package imports do not resolve from here.

## Try it

```sh
# 1. watch the dot wake up and pulse
tail -f /Users/eramadan/opendot/.dot/heartbeat.log

# 2. hand it a trigger directly
echo '{"from":"me","message":"check the intake queue"}' >> /Users/eramadan/opendot/.dot/inbox.jsonl

# 3. start a session on the dot preset in the DSH GUI (preset: "Dot"),
#    then ask it:
#    - "schedule a heartbeat self-check every 5 minutes"   (dot_schedule add-every)
#    - "remember that prod kubeconfig context is 'prod-eks'" (dot_remember)
#    - "what do you know about castai?"                     (dot_recall)
#    - "show me your policy"                                (dot_policy view)
```

## Roadmap

- **v0.1 (this)** — core/scheduler/memory/policy, file rows, mount-validated
- v0.2 — dot-events: webhooks (`webhookRuntime`), GitHub/Slack/alert triggers; mid-idle wake by steering the agent directly
- v0.3 — dot-agents: specialist subagent roster; vector recall; MCP tools
- v0.4 — graduate to TypeScript packages + `dsh plugin add` bundles; dot-ui Slot panel; remote always-on deployment (EKS, Hatchet/Temporal)
