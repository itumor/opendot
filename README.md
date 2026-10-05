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
     ┌────────┬──────────┴─┬────────┬──────────┬───────────┐
     │        │            │        │          │           │
 dot-core  dot-        dot-    dot-    dot-      dot-
 state     scheduler  memory  policy  events    profile
 home      heartbeat  memory  rules   HTTP      identity +
 kv,inbox, + durable  recall   +       ears      preferences
 journal,  wakeups            guard   + status
 dot_state                           view
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
  lib/dotgh.js      GitHub webhook verification (HMAC-SHA-256) + event→task mapping
  lib/dotprefs.js   profile/preferences parsing + feedback shaping (pure)
  lib/dotrollup.js  daily status.md builder (pure): day filter, counts, anomalies
  dot-core.js       service dotCore + tool dot_state + dot.status prompt context
  dot-scheduler.js  service dotScheduler + tool dot_schedule + heartbeat
  dot-memory.js     service dotMemory + tools dot_remember / dot_recall
  dot-policy.js     service dotPolicy + tool dot_policy + tools.guard enforcement
  dot-events.js     service dotEvents + tool dot_event + HTTP routes (v0.2)
  dot-profile.js    service dotProfile + tools dot_profile / dot_feedback +
                    dot.profile prompt section (identity + operator model, v0.3)
  dot-report.js     service dotReport + tool dot_report: daily status pages
                    (status/YYYY-MM-DD.md), linked from tasks.md (v0.3)
  *.entry.js        stable-URL mount shims — preset rows point at these
tests/              node:test suite (npm test), no dependencies
```

### The entry-shim contract

Preset rows must reference `plugins/<organ>.entry.js`, never the organ file
itself. DSH imports file rows once per process and Node caches modules per
URL forever, so a row aimed at an organ would silently keep running its
first-ever evaluation on every remount — and a stale cached `lib/*.js` fails
the whole mount with `does not provide an export named …`. Each shim is
permanent and logic-free: its `apply()` re-imports the organ behind a
per-mount-unique query on every mount, and each organ re-imports its `lib/*`
helpers behind `?mtime=<stamp>` queries. Editing an organ or a helper
therefore takes effect on the next mount — no build step, no harness restart
— while unedited helpers stay single-instance across all organs. Two
boundaries, both loud rather than silent: an organ's `name`/`inject` surface
is frozen per process (changing plugin identity needs a harness restart), and
every mount adds one small module record. Never add behavior to a shim.

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

## GitHub bridge (v0.3)

Set `ghSecret` in the dot-events config row to the same token as a GitHub
webhook secret, and point the webhook (repo → Settings → Webhooks, content
type `application/json`, events: issues, issue comments, PRs, checks,
workflow runs, pushes, ping) at `https://<your-host>/dot/hook/github`:

- Every delivery is HMAC-verified (`X-Hub-Signature-256` over the raw body,
  timing-safe compare) — a forged POST gets 401 and a journal entry, never
  an inbox item.
- Verified events land in `inbox.jsonl` task-shaped: CI failure →
  *investigate* (with run URL), issue opened/closed → *triage/reconcile*,
  comment → *triage (dot mentioned?)*, PR opened ⇒ *review or run tests*.
  Successful checks and in-progress runs are acknowledged, not enqueued.
- Without `ghSecret` the same path stays an ordinary raw webhook — no
  surprise lockouts on a half-configured upgrade.

## Daily status pages (v0.3)

`/dot/status` answers "what is the dot doing now"; dot-report answers "what
did the dot do on day D" — one `status/YYYY-MM-DD.md` per alive day, built
deterministically (no model call) from journal + drained inbox + rounds +
heartbeats: what fired, what the loop did, anomalies (restarts, route
conflicts, write errors). Pages link themselves from `tasks.md`.

The cadence is one durable schedule — arm it once, miss nothing:

```
dot_schedule add-every --name daily-rollup --everySeconds 86400 \
  --task 'STATUS ROLLUP: run dot_report write (default yesterday); if the tool is unavailable, remount the preset'
```

`dot_report backfill` writes every alive day missing its page; `dot_report
list` shows what exists. Mount the `dot-report` preset row first (see
`deploy/agent.cordis.yml`).

## Multi-project rounds

A dot juggling several projects must not just take the top line of
`tasks.md` — order accretes, so top-of-file means oldest, not most valuable.
The convention ([docs/multi-project-board.md](docs/multi-project-board.md)):
`tasks.md` stays the flat standing list, `projects.md` holds one section per
project (`state` / `value` / `urgency` / a single `next:` action), and each
work round advances the project with the highest `value × urgency` by one
durable increment, rewriting its `next:` in the same round. The doc carries
the persona paragraph that teaches the loop the rule.

## Idle-time curiosity queue

Between instructions the dot should get *more useful*, not just stay alive.
The convention ([docs/curiosity-queue.md](docs/curiosity-queue.md)):
`.dot/curiosity.md` holds a prioritized queue of read-only research items
harvested from tasks.md, memory.md and the journal; a durable hourly
schedule fires a pulse that researches exactly ONE item (read-only, one per
pulse, `parked` for anything needing writes or credentials) and files
findings into memory.md plus `curiosity/<slug>.md` notes. The doc carries
the persona paragraph that teaches the loop the bounds.

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
| `projects.md` | you + dot | portfolio view: one ranked `next:` per project (see docs/multi-project-board.md) |
| `curiosity.md` + `curiosity/` | you + dot | idle-time read-only research queue + finding notes (see docs/curiosity-queue.md) |
| `status/<day>.md` | dot-report | daily rollup: what the dot did, what fired, anomalies (`dot_report`) |

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

The `dot` preset at `~/.dsh/.agent-presets/dot/agent.cordis.yml` mounts the `*.entry.js` shims via absolute `file://` rows inside one isolated `cordis:group` (see `deploy/agent.cordis.yml` in this repo for a copy):

```yaml
- id: dot
  name: cordis:group
  group: true
  isolate: { dotCore: true, dotMemory: true, dotScheduler: true, dotPolicy: true, dotEvents: true, dotProfile: true }
  config:
    - id: dot-core
      name: 'file:///path/to/plugins/dot-core.entry.js'
      config: { root: /path/to/dot-home }
    - id: dot-scheduler
      name: 'file:///path/to/plugins/dot-scheduler.entry.js'
      config: { heartbeatSeconds: 60 }
    - id: dot-memory
      name: 'file:///path/to/plugins/dot-memory.entry.js'
    - id: dot-policy
      name: 'file:///path/to/plugins/dot-policy.entry.js'
    - id: dot-events
      name: 'file:///path/to/plugins/dot-events.entry.js'
      config: { }
    - id: dot-profile
      name: 'file:///path/to/plugins/dot-profile.entry.js'
```

Plugin module contract: ESM named exports `name`, optional `inject`, `apply(ctx, config)`; provide services with `ctx.provide(name, value)`; consume with `ctx.get`/`inject`; keep every side effect fiber-owned (`ctx.interval`, `ctx.effect`). Node builtins only — bare package imports do not resolve from here.

## Tests

```sh
npm test    # node --test tests/ — storage, rules engine, schedules, HTTP layer
```

## Identity and learning (v0.3, first slice: dot-profile)

OpenAI's dots start by getting a name and grow by learning what good looks like. dot-profile is that layer:

- `profile.json` in the dot home — `{ name, tagline, operator }`, operator-editable; every step the `dot.profile` prompt section carries it in front of the model.
- `preferences.md` — a curated section of stable operator preferences up top, and a `## feedback log` at the bottom where `dot_feedback` appends (+)/(−)/(~) signals. The log stays last; the dot distils repeated patterns into curated by editing the file.
- Tools: `dot_profile view|reload`, `dot_feedback {signal, note, context?}`.

## Roadmap

- **v0.1** — core/scheduler/memory/policy, file rows, mount-validated ✅
- **v0.2** — dot-events: HTTP inbox, named webhooks, `/dot/status` activity view; policy engine extracted to a tested module; test suite ✅
- **v0.3 (current)** — dot-profile identity + preferences/feedback ✅ (first slice); ranked recall (term coverage + recency + tag filters) ✅; daily status rollups ✅; multi-project board ✅; GitHub bridge ✅ (ingress follow-up #11); curiosity queue ✅; specialist sub-dot roster; Slack bridge on `/dot/hook`
- v0.4 — graduate to TypeScript packages + `dsh plugin add` bundles; dot-ui panel; remote always-on deployment (EKS, Hatchet/Temporal)

## Parity with OpenAI dots

| dots feature | opendot status |
|---|---|
| Always-on, works on its own | ✅ standing goal loop + heartbeat + durable wakeups |
| Own computer you can inspect | ✅ workspace + sandbox; `/dot/status` activity view |
| Works where you work (Slack/Teams/text) | ◐ webhooks today; Slack/Teams bridges on the v0.3 list |
| Proactive research while idle | ◐ schedule-driven; richer idle-time work queue planned |
| Custom Rules (allow/approve/block) | ✅ policy.json with advisory/enforce modes |
| Learns preferences from feedback | ✅ dot_feedback capture + curated preferences.md (curation loop growing) |
| Give it a name, make it your own | ✅ profile.json name/tagline/operator, in the prompt every step |
| Activity review and approvals | ◐ journal + status page; in-chat approval flow via policy `ask` |
| Teams of specialist dots | ◐ subagents today; specialist roster in v0.3 |
| Plugin ecosystem (apps) | ❌ webhooks are the wedge; MCP tools under consideration |
