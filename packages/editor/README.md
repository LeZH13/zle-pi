# @zle13/pi-editor

Show the explicit session name right-flush on the Pi input editor top border. Unnamed sessions render the native border with no badge.

## Installation

```bash
pi install npm:@zle13/pi-editor
```

Or install locally from source:

```bash
pi install -l ./packages/editor
```

Then launch Pi in TUI mode or run `/reload`.

## Behavior

- **Named session** (`/name foo`, `--name foo`, `pi.setSessionName()`): top border ends with ` foo ──`, one leading space, two trailing dashes, same color as the editor dividers.
- **Unnamed session** (undefined, empty, or whitespace-only): native Pi border untouched.
- **Working / scroll states**: the badge composes over `super.renderTopBorder()`, so the working spinner (`── ◐ Working…`) and scroll indicator (`↑ N more`) keep their native positions on the left/center.
- **Narrow terminals / long names**: names truncate with `…`; if fewer than 8 columns remain for the badge, the native border wins.
- **Conflicts**: if another custom editor is already active (e.g. Zentui), this extension defers and notifies once per session.

```text
named idle:    ────────────────────── my-session ──
named working: ── ◐ Working… ────────── my-session ──
named scroll:  ─────── ↑ 3 more ──────── my-session ──
unnamed:       ────────────────────────── (native)
```
