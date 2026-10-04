# opendot

**opendot** — an open, always-on personal agent built on [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH), modeled on [OpenAI's dots](https://openai.com/index/introducing-dots/): keeps goals, wakes on schedules and events, holds long-term memory, and acts under operator-set autonomy rules.

No build step, no npm install, no fork: the `dot` agent preset references the plugin files directly, so editing a file here changes the dot on its next mount.

> Local checkout lives at `deepseek-dot/`; the GitHub project is `opendot`. Same repo, same history.

## What an opendot is

```
             DeepSeek Harness process
                      │
           dot agent preset (agent.cordis.yml)
                      │
     ┌────────┬───────┴─────────┬──────────┬─────────────┐
     │        │                 │          │             │
 dot-core  dot-scheduler   dot-memory  dot-policy   dot-events
 state     heartbeat +     memory.md   policy.json  HTTP ears:
 home      durable         dot_remember rules +     inbox, webhooks,
 kv,inbox, wakeups         dot_recall   enforcement status view
 journal,
 dot_state
```

The always-on loop (the wake path is deliberately *write-only* — schedulers and webhooks never call a model; they write to `inbox.jsonl`, and the dot's standing goal loop drains it and does the thinking. Tokens get spent on work, not on polling):

```
 timer tick (dot-scheduler)        external trigger (curl, cron, webhook)
        │                                    │
        ▼                                    ▼
 heartbeat.log + due schedules ──▶  inbox.jsonl  ◀── POST /dot/hook/*
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

## Layout

```
plugins/
  lib/dotstore.js   atomic JSON writes, JSONL journals, tail reads
  lib/dottool.js    shared ToolDefinition builder
  lib/dotrules.js   policy decision engine (pure, unit-tested)
  lib/dothttp.js    HTTP primitives: bodies, queries, secrets, HTML escaping
  dot-core.js       service dotCore + tool dot_state + dot.status prompt context
  dot-scheduler.js  service dotScheduler + tool dot_schedule + heartbeat
  dot-memory.js     service dotMemory + tools dot_remember / dot_recall
  dot-policy.js     service dotPolicy + tool dot_policy + tools.guard enforcement
  dot-events.js     service dotEvents + tool dot_event + HTTP routes (v0.2)
tests/              node:test suite (npm test), no dependencies
```

## HTTP event surface (v0.2)

Once mounted in a `dsh web` process, the dot grows ears and an activity view:

| route | verb | what it does |
|---|---|---|
| `/dot/inbox` | GET/POST | enqueue a trigger: `?from=cron&message=hourly+sweep` or JSON body |
| `/dot/hook/<name>` | POST | named webhook ingress — body (JSON or raw) becomes the payload of an `kind: webhook` inbox item |
| `/dot/status` | GET | activity view: auto-refreshing HTML dashboard, or JSON with `?format=json` |

- Set `secret` in the dot-events config row to gate the write endpoints (`x-dot-secret` header or `?secret=`). `/dot/status` is always open (loopback bind, read-only).
- Route conflicts (two dots in one process) degrade per route and are reported on the status page — never fatal.
- webServer absent (CLI session): the dot keeps every other organ; only the HTTP ears sit out.

```sh
curl "http://127.0.0.1:3080/dot/inbox?from=cron&message=hourly%20sweep"
curl -X POST "http://127.0.0.1:3080/dot/hook/github-ci" -d '{"repo":"app","conclusion":"failure"}'
open "http://127.0.0.1:3080/dot/status"
```

## State home

Everything the dot persists lives as plain files in its home (e.g. `~/opendot/.dot`):

| file | owner | contents |
|---|---|---|
| `kv.json` | dot-core | durable key/value state (`dot_state`) |
| `inbox.jsonl` | dot-core | pending triggers; drained → `inbox.done.jsonl` |
| `heartbeat.log` | dot-scheduler | liveness pulse, one line per tick |
| `journal.jsonl` | all | append-only audit spine |
| `memory.md` | dot-memory | long-term notes (`dot_remember`/`dot_recall`) |
| `policy.json` | dot-policy | autonomy rules (`dot_policy`) |
| `schedule.json` | dot-scheduler | durable wakeups (`dot_schedule`) |
| `tasks.md` | you + dot | standing tasks (driven by the persona) |

Files are the interface: read, edit, or append any of them directly; the dot rebuilds safely from partial state (atomic writes, seen-JSON fallbacks, torn-line-tolerant journals).

## policy.json — autonomy rules

```json
{ "mode": "advisory", "allow": ["*"], "ask": [], "deny": [] }
```

- Patterns: exact name, `prefix*`, or `*`. Precedence: **deny > ask > allow**.
- `advisory` — rules guide the model through its prompt; the hard `deny` list still blocks execution.
- `enforce` — `ask` tools are blocked with instructions: confirm with the operator in chat, then `dot_policy {action:"allow-once", tool:"<name>"}` and retry once. Grants are in-memory and expire with the run.
- `dot_*` tools are never gated — a dot can't lock itself out of its own policy.

## Mounting

The `dot` preset at `~/.dsh/.agent-presets/dot/agent.cordis.yml` mounts these files via absolute `file://` rows inside one isolated `cordis:group` (see `deploy/agent.cordis.yml` in this repo for a copy):

```yaml
- id: dot
  name: cordis:group
  group: true
  isolate: { dotCore: true, dotMemory: true, dotScheduler: true, dotPolicy: true, dotEvents: true }
  config:
    - id: dot-core
      name: 'file:///path/to/plugins/dot-core.js'
      config: { root: /path/to/dot-home }
    - id: dot-scheduler
      name: 'file:///path/to/plugins/dot-scheduler.js'
      config: { heartbeatSeconds: 60 }
    - id: dot-memory
      name: 'file:///path/to/plugins/dot-memory.js'
    - id: dot-policy
      name: 'file:///path/to/plugins/dot-policy.js'
    - id: dot-events
      name: 'file:///path/to/plugins/dot-events.js'
      config: { }
```

Plugin module contract: ESM named exports `name`, optional `inject`, `apply(ctx, config)`; provide services with `ctx.provide(name, value)`; consume with `ctx.get`/`inject`; keep every side effect fiber-owned (`ctx.interval`, `ctx.effect`). Node builtins only — bare package imports do not resolve from here.

## Tests

```sh
npm test    # node --test tests/ — storage, rules engine, schedules, HTTP layer
```

## Roadmap

- **v0.1** — core/scheduler/memory/policy, file rows, mount-validated ✅
- **v0.2 (current)** — dot-events: HTTP inbox, named webhooks, `/dot/status` activity view; policy engine extracted to a tested module; test suite
- v0.3 — dot-profile: a named identity, `preferences.md` operator model, feedback capture ("learns what good looks like"); specialist sub-dot roster; GitHub/Slack bridges on top of `/dot/hook`; vector recall
- v0.4 — graduate to TypeScript packages + `dsh plugin add` bundles; dot-ui panel; remote always-on deployment (EKS, Hatchet/Temporal)

## Parity with OpenAI dots

| dots feature | opendot status |
|---|---|
| Always-on, works on its own | ✅ standing goal loop + heartbeat + durable wakeups |
| Own computer you can inspect | ✅ workspace + sandbox; `/dot/status` activity view |
| Works where you work (Slack/Teams/text) | ◐ webhooks today; Slack/Teams bridges on the v0.3 list |
| Proactive research while idle | ◐ schedule-driven; richer idle-time work queue planned |
| Custom Rules (allow/approve/block) | ✅ policy.json with advisory/enforce modes |
| Learns preferences from feedback | ◐ memory.md today; dedicated preference model in v0.3 |
| Give it a name, make it your own | ◐ preset persona today; dot-profile identity in v0.3 |
| Activity review and approvals | ◐ journal + status page; in-chat approval flow via policy `ask` |
| Teams of specialist dots | ◐ subagents today; specialist roster in v0.3 |
| Plugin ecosystem (apps) | ❌ webhooks are the wedge; MCP tools under consideration |
