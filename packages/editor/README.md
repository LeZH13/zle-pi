# @zle13/pi-editor

Show the explicit session name right-flush on the Pi input editor top border, and vim-style modal editing with a mode indicator on the bottom border. Unnamed sessions render the native border with no badge.

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

## Modal editing

The main prompt editor starts in **INSERT** mode. Escape enters **NORMAL** mode (and cancels an open completion first). Escape cancels a pending normal-mode command; otherwise, in normal mode it retains Pi's interrupt action. Insert mode keeps Pi's normal typing, submission (`enter`), and newline (`ctrl+j`). Unowned controls such as `ctrl+c` and `ctrl+d` still go to Pi.

This is a deliberately small, editor-local Vim subset, not a complete Vim implementation. Supported motions operate on logical prompt lines; `w`/`b`/`e` distinguish keyword runs from punctuation and whitespace. Counts repeat motions, `x`, `s`, `dw`, `dd`, `cw`, `cc`, and undo/redo (for example `3w`, `2dd`, `3u`). Counts on `i/a/I/A`, `o/O`, and line-end edit actions are ignored.

| Keys | Action |
|------|--------|
| `h` `j` `k` `l` | Move left / down / up / right |
| `0` `^` `$` | Start / first nonblank / last character of line |
| `w` `b` `e` | Next word start / previous word start / word end |
| `i` `a` `I` `A` | Insert before / after cursor / first nonblank / line end |
| `o` `O` | Open a line below / above and insert |
| `x` `s` | Delete character / delete character and insert |
| `dw` `cw` | Delete word including trailing whitespace / change word leaving trailing whitespace |
| `dd` `cc` | Delete line / change line |
| `d$` `D` / `c$` `C` | Delete / change to end of line |
| `u` / `ctrl+r` | Undo / redo; a normal-mode edit is one undo step |

Character deletion stops at the line boundary. `dd` removes the line and its separator; on the last remaining line it leaves an empty editor. `ctrl+r` in normal mode is Vim redo, **not** Pi's session-rename shortcut. Pi's insert-mode undo binding remains available. Insert-mode typing retains Pi's native word/space undo grouping rather than Vim's whole-insert-session grouping (for example, undo after typing `hello world` leaves `hello`). The undo/redo implementation currently depends on Pi editor internals and should be retested when upgrading Pi.

Normal-mode keys mutate the editor state directly, not through user-configured Pi editor keybindings; insert-mode keys retain those bindings. Unsupported printable keys and bracketed paste in normal mode are ignored, and an incomplete operator combination is discarded. There is no `p/P` or yank/register support, buffer-level `gg/G`, distinct `W/B/E` WORD motions, search, text objects, or general operator grammar. Use insert mode and Pi's native shortcuts for other edits.

The bottom border shows ` NORMAL ──` or ` INSERT ──` and pending keys such as ` NORMAL 3d ──`.
