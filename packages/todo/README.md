# @zle13/pi-todo

Give the model a task list you can see. This package adds a `todo` tool, a
`/todos` command, and a live collapsible panel above the editor to
[Pi Agent](https://github.com/earendil-works/pi). The list is rebuilt from the
session branch, so it survives `/reload` and compaction.

Adapted from [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
(MIT; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)), rewritten with a
command-driven control surface, session-scoped enablement, and an execution
guard.

## Install

Install with `pi install npm:@zle13/pi-todo`, or try it locally from this checkout:

```sh
pi -ne -e ./packages/todo          # one-off trial (--no-extensions avoids tool-name
                                   # conflicts with an already-installed todo package)
pi install -l ./packages/todo      # or install into this project's settings (-l = local)
```
Restart your Pi session after installing.

## Usage

### `/todos`

| Invocation | Effect |
| --- | --- |
| `/todos` | Toggles tracking for the current session |
| `/todos status` | Reports tracking state (on/off, collapsed/expanded) and the task list grouped by status |
| `/todos collapse` | Collapses the panel to its one-line summary |
| `/todos expand` | Expands the panel to full rows |

Anything else prints usage. Typing `/todos` offers prefix-filtered argument
completions for `status`, `collapse`, and `expand`. In TUI mode, you can also
click the overlay header to toggle between collapsed and expanded. A toggle never
launches an agent turn.

### Session-scoped enablement

Tracking starts **off for every new session**. A `/todos` toggle records an
entry on the session branch, so enablement is remembered across resume and
`/reload`, and inherited by forks. There is no global enablement switch. Each
session lifecycle event (start, compaction, tree navigation — headless
sessions included) reconciles the active tool set with the session's
enablement, touching only the `todo` tool and never unrelated tools. Tracking
does not auto-disable when tasks complete; the model is authorized to track
complex work (3+ meaningful steps with meaningful, verifiable milestones) or
explicit user requests while enabled.

### The overlay

When tracking is on and tasks exist, a panel renders above the editor:

- **Collapsed** (default): one width-safe line —
  `▸ Todos 1/3 · implementing controls` — where the activity label comes from
  the in-progress task's `activeForm`. All completed: `▸ Todos 2/2 · all
  completed`.
- **Expanded**: a `Todos (done/total)` heading plus one row per task with
  status glyphs, `#id` prefixes when dependencies exist, blockedBy chains, and
  a `+N more (2 completed, 1 pending)` overflow summary past the row budget.

Task updates never expand the panel, a panel with no tasks disappears, and an
all-completed summary stays visible until the list is cleared.

### Tracking off

While a session's tracking is off:

- the overlay is hidden;
- the `todo` tool and its guidance are removed from model requests;
- `execute()` is guarded even for indirect calls (e.g. via `ctx.executeTool()`).

Task state is preserved the whole time: `/todos status` still lists it, and
`/todos` re-enables tracking where you left off.

## The `todo` tool

Actions: `create`, `update`, `list`, `get`, `delete` (tombstone), and `clear`.
Statuses: `pending → in_progress → completed`, plus `deleted`. Pass
`activeForm` (a present-continuous label) when marking `in_progress`; it is
shown in the panel and `/todos` output while the task runs.

Dependencies are expressed with `blockedBy` (create) or `addBlockedBy` /
`removeBlockedBy` (update, additive merge). Dangling ids, deleted
dependencies, self-blocks, and cycles are rejected before anything is
written, and invalid mutations fail as tool errors. Every successful call —
direct or indirect (nested `ctx.executeTool()` from another tool) — persists
the full post-mutation snapshot as a session entry on the calling branch at
execution time. Replay rebuilds the list from those snapshots in execution
order; transcript tool results are not replayed (in a parallel batch they are
recorded in call order after all executions, which can be stale).

### Model guidance

While the tool is active, the model is guided to open a list for complex work
with 3+ meaningful steps that have meaningful, verifiable milestones — or when
the user explicitly asks for task tracking — not for artificial splitting and
not merely because new instructions arrived, and to keep full completion
discipline: mark work in progress before starting, complete immediately when
done, never batch, and never complete with failing tests or partial work.

## Preferences

The collapsed/expanded view is global and saved to
`~/.config/pi-todo/config.json` (or `$XDG_CONFIG_HOME/pi-todo/config.json`):

```json
{
  "collapsed": true
}
```

Changes apply to the current process and future starts only — there is no
live cross-process synchronization. A missing or malformed file falls back to
the default (collapsed). Enablement is not stored here: it is per session,
recorded on the session branch. The package only writes this file for view
changes; nothing else reads or writes it.

## Requirements

- A Pi Agent host. No API key, no model selection, no native dependencies.
- The panel renders in interactive sessions; `/todos` state changes also work
  headless (nothing is rendered).

## Development

```sh
npm test --workspace @zle13/pi-todo      # vitest
npm run typecheck --workspace @zle13/pi-todo
npm run pack:check --workspace @zle13/pi-todo
```

## License

MIT — see [LICENSE](./LICENSE). Derived from
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo);
attribution in [NOTICE](./NOTICE).
