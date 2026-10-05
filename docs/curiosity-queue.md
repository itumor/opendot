# Idle-time curiosity queue

Between instructions, a dot should get *more useful*, not just stay alive.
The curiosity queue is how: a self-maintained list of read-only research
items the dot waters on an hourly pulse — one item at a time — filing what
it learns into its own memory so findings survive context compaction.

## The file: `.dot/curiosity.md`

```markdown
# Curiosity queue

Read-only research for idle pulses. Rules: ONE item per pulse; findings
land in memory.md plus a note under curiosity/<slug>.md; nothing is ever
written outside this dot home unless the item itself says so.

## queue
- [ ] How do OpenAI dots authenticate "works where you work" surfaces?
      from: tasks.md parity mission · added: 2026-10-05
- [ ] What breaks dot-report when journal.jsonl passes 100k lines?
      from: rollup backfill run · added: 2026-10-05

## parked (waiting on the operator)
- [ ] Slack bridge reply path — needs the workspace token decision

## done
- [x] HMAC tolerance of GitHub webhook libraries — findings: memory
      2026-10-05 #webhook · note: curiosity/github-hmac.md
```

Three sections, forever: `queue` (open, order is the priority — the dot
reorders freely when it learns better), `parked` (blocked on the human, so
pulses skip them), `done` (audit trail with pointers to the findings).

## The pulse

One durable schedule — `dot_schedule add-every curiosity-pulse 3600s` —
whose task text tells the dot to drain exactly one item:

> CURIOSITY PULSE: if nothing operator-facing is pending, take the FIRST
> unchecked item in .dot/curiosity.md's queue. Research it read-only —
> docs, source, the web; no writes outside the dot home — then file the
> findings via dot_remember and a note at .dot/curiosity/<slug>.md, and
> mark the item [x] with pointers. Then stop: one item per pulse.

Bounds that keep the habit healthy:

- **One item per pulse, hard.** A pulse that finds the queue empty, or
  finds higher-priority inbox/schedule work waiting, skips quietly.
- **Read-only by default.** Research may read the world; it may only
  *write* memory.md, curiosity notes, and the queue itself. An item that
  demands more (install something, edit a repo, spend money) moves to
  `parked` with a note for the operator instead.
- **Small findings, well filed.** The point is durable learning in small
  increments: a two-line memory fact with a why beats an essay.

## Harvesting

The queue self-feeds: whenever a round ends with an unanswered
"I wonder…" — a gap noticed in tasks.md, a mystery in memory.md or the
journal, a decision deferred as "needs research" — the dot appends one
line to `queue` with `from:` citing the source. The operator can also just
edit the file; it is plain markdown.

## Persona paragraph (preset operators)

```
Your dot home has curiosity.md — a queue of read-only research items you
harvest from tasks.md, memory.md, and the journal. When a curiosity-pulse
schedule fires and nothing operator-facing is pending, take the FIRST
unchecked queue item, research it read-only (never write outside the dot
home unless the item says so), file findings via dot_remember plus a note
at curiosity/<slug>.md, and mark the item [x] with pointers. One item per
pulse; an item needing writes/credentials goes to parked with a note for
the operator. When a round leaves an open question behind, append it to
the queue with a from: citation.
```
