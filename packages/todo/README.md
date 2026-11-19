# @zle13/pi-todo

Session-scoped task tracking for [Pi Coding Agent](https://pi.dev): adds a `todo` model tool with dependency support, a `/todos` command, and a collapsible live progress panel above the editor that survives `/reload` and compaction.

Adapted from [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) (MIT; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)).

## Installation

```bash
pi install npm:@zle13/pi-todo
pi -ne -e npm:@zle13/pi-todo   # try in isolation (avoids conflicts with other todo extensions)
```

Restart Pi after installing.

## Commands

| Command | Description |
| --- | --- |
| `/todos` | Toggle task tracking on/off for the current session |
| `/todos status` | Show tracking state and all tasks grouped by status |
| `/todos collapse` | Collapse the panel to a single summary line |
| `/todos expand` | Expand the panel to show full task rows |

In TUI mode, click the panel header to toggle collapsed/expanded. Toggling never triggers an agent turn.

## How it works

### Session-scoped enablement

- Tracking starts **off** for every new session and is enabled per session with `/todos` (persisted on the session branch across reload, resume, compaction, and fork).
- While **off**, the panel is hidden, the `todo` tool and its prompt guidance are removed from model requests, and direct/indirect tool calls are blocked. Saved tasks stay intact and reappear when re-enabled.

### Live progress panel

When tracking is on and tasks exist, a panel renders above the editor:

- **Collapsed** *(default)*: single width-safe line—`▸ Todos 1/3 · implementing controls` (using the in-progress task's `activeForm`), or `▸ Todos 2/2 · all completed`.
- **Expanded**: `Todos (done/total)` heading with status glyphs, `#id` and `blockedBy` chains when dependencies exist, and a `+N more` overflow summary.

Task updates never force-expand the panel, and clearing all tasks hides it.

### The `todo` tool

- **Actions:** `create`, `update`, `list`, `get`, `delete` (tombstone), and `clear`.
- **Statuses:** `pending` → `in_progress` → `completed` (plus `deleted`), with an `activeForm` label shown while a task is in progress.
- **Dependencies:** `blockedBy` on create, `addBlockedBy` / `removeBlockedBy` on update. Self-blocks, dangling/deleted IDs, and cycles are rejected before writing.
- **Branch persistence:** each mutation saves a post-mutation snapshot on the session branch so task state replays accurately across reload, fork, tree navigation, and compaction.
- **Model guidance:** while enabled, guides the model to track multi-step work (3+ verifiable milestones) or explicit user requests, marking tasks in progress before starting and completing them only when verified.

## Preferences

The collapsed/expanded view preference is stored globally at `~/.config/pi-todo/config.json` (or `$XDG_CONFIG_HOME/pi-todo/config.json`):

```json
{
  "collapsed": true
}
```

## License

MIT — see [LICENSE](./LICENSE). Derived from [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo); attribution in [NOTICE](./NOTICE).
