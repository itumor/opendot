# Multi-project board conventions

A dot lives across rounds, restarts, and context compactions — it cannot hold
"what matters" in its head, and its operator doesn't want one thread per
project. Two files split the job; both are plain markdown, human-editable,
and safe to edit while the dot runs.

## The two files

### `tasks.md` — the flat standing list (unchanged)

Operational, per-dot: checkboxes for standing duties (keep the loop alive,
drain the inbox, obey policy), the product mission pointer, resolved items,
and the `## status reports` link farm dot-report maintains. It stays flat on
purpose: anything that scans one file top-to-bottom keeps working.

### `projects.md` — the portfolio view (this convention)

One section per project, newest decision first:

```markdown
# Projects

## opendot — parity with OpenAI dots
state: active          # active | parked | blocked | done
value: 5               # 1–5: what finishing is worth
urgency: 4             # 1–5: how fast the value decays
horizon: this-month    # this-week | this-month | someday
next: close GitHub issue #4 — GitHub webhook bridge
where: https://github.com/itumor/opendot/issues

## home-server migration
state: parked
value: 3
urgency: 1
horizon: someday
next: inventory Docker volumes before touching anything
where: ~/ops/server.md
```

Rules that keep it honest:

- **`next:` is one action, sized for one round.** "Migrate the server" is not
  a next action; "inventory Docker volumes" is. If a round could not finish
  it, it was two actions.
- **Exactly one `next:` per project.** Choosing is the file's whole job.
- **`where:` points at the board of record** (issue tracker, ops file). The
  portfolio ranks work; it does not duplicate the work items.
- **Done projects sink.** `state: done` plus the date, moved to the bottom —
  history, not clutter.

## The round rule (what the loop does differently)

Without a portfolio the loop advances whatever sits at the top of `tasks.md`
— order accretes, so top-of-file means "oldest", not "most valuable". With
`projects.md` present, each **work round**:

1. computes `priority = value × urgency` per active project
   (ties: earlier section wins);
2. advances the winning project's `next:` by **one small durable increment**;
3. updates that project's `next:` — and `value:`/`urgency:` if they drifted —
   in the *same* round, so the file is never stale;
4. journals the choice (`kind: work`, project name + increment), so the
   operator can audit not just what happened but what was *chosen over what*.

Quiet rounds (inbox only, heartbeats) don't touch the portfolio.

## Persona paragraph (preset operators)

Paste into the dot preset's persona suffix, after the standing-round
instructions:

```
Your dot home has projects.md — a portfolio of the projects you juggle, one
section per project with state/value/urgency (1–5) and exactly one next:
action. During work rounds, choose work by portfolio, not by tasks.md order:
rank active projects by value × urgency (ties go to the earlier section),
advance the winner's next: by one small durable increment, and rewrite that
project's next: in the same round. Quiet rounds (inbox/heartbeat upkeep) do
not touch it. The file is yours to keep honest: bump value/urgency when the
world moves, reword a next: that turned out to be two actions, sink finished
projects to the bottom with their date.
```

## Relationship to the issue board

GitHub issues (or any tracker) remain the work-item board — fine-grained,
labeled, closable. `projects.md` answers the coarser question issues can't:
*which project deserves this round?* The issue queue serves the winning
project, never the other way around.
