# @zle13/pi-editor

A Vim-style modal prompt editor for [Pi Coding Agent](https://pi.dev) with a top-border session-name badge, a thinking-color working border trail, and an inline `$$` shell-command clipboard picker.

## Installation

```bash
pi install npm:@zle13/pi-editor
pi -e npm:@zle13/pi-editor   # try for one session
```

Then launch Pi in TUI mode or run `/reload`.

## Border & working indicator

```text
named idle:    ────────────────────── my-session ──
named working: ── ◐ Working… ────────── my-session ──
named scroll:  ─────── ↑ 3 more ──────── my-session ──
unnamed:       ────────────────────────── (native)
```

- **Session-name badge:** named sessions (`/name`, `--name`, or `pi.setSessionName()`) show ` <name> ──` on the top-right border. Long names truncate with `…`, and narrow terminals (< 8 columns remaining) fall back to the native border. Unnamed sessions leave the native border untouched.
- **Working border trail:** while Pi's working, retry, compaction, or branch-summary indicator is active, a subtle single-hue gradient trail matching the current thinking-level color (or Bash-mode color) sweeps clockwise around the top and bottom borders, softly lighting up the spinner, session name, and mode label as it passes. No timer runs while idle.
- **Conflicts:** if another custom editor is already active (e.g. Zentui), this extension defers and notifies once per session. Both `$$` and `/copy-command` require this extension to own the editor.

## Modal editing

Starts in **INSERT** mode. Press `Escape` to enter **NORMAL** mode (or dismiss an open copy menu/completion first); pressing `Escape` again in normal mode retains Pi's interrupt action. The bottom-left border shows `── INSERT ───` or bold `── NORMAL ───` (plus pending keys like `── NORMAL 3d ───`).

| Keys | Action |
| --- | --- |
| `h` `j` `k` `l` | Move left / down / up / right |
| `0` `^` `$` | Start / first nonblank / last character of line |
| `w` `b` `e` | Next word start / previous word start / word end |
| `i` `a` `I` `A` | Insert before / after cursor / first nonblank / line end |
| `o` `O` | Open a line below / above and insert |
| `x` `s` | Delete character / delete character and insert |
| `dw` `cw` | Delete word (with trailing space) / change word (keeping trailing space) |
| `dd` `cc` | Delete line / change line |
| `d$` `D` / `c$` `C` | Delete / change to end of line |
| `u` / `ctrl+r` | Undo / redo (each normal-mode edit is one undo step) |

- **Counts:** numeric prefixes repeat motions, `x`, `s`, `dw`, `dd`, `cw`, `cc`, and undo/redo (e.g. `3w`, `2dd`, `3u`).
- **Hardware cursors:** switches automatically between a steady block (`\x1b[2 q`) in NORMAL mode and a steady beam (`\x1b[6 q`) in INSERT mode, restoring the terminal default (`\x1b[0 q`) on exit.
- **Intentional subset:** covers core single-prompt editing only—no yank/registers (`p`/`P`), `gg`/`G`, `W`/`B`/`E`, search, or text objects. `ctrl+r` in normal mode is Vim redo (not Pi's rename shortcut); insert mode retains Pi's native shortcuts and undo grouping.

## Copy shell commands (`$$`)

Type **`$$` into an empty editor in INSERT mode** (or run `/copy-command`) to open an inline clipboard picker for shell commands from recent assistant replies—no Enter required.

- **Filter inline:** keep typing after `$$` (e.g. `$$git`) to filter case-insensitively. Delete either `$` to dismiss. To type a literal leading `$$`, paste it instead (`$HOME`, mid-prompt `$`, and normal-mode `$` do not trigger copy mode).
- **What's indexed:** scans the **last 10 assistant messages** on the current branch (newest first, labelled `R0`, `R1`, …) for closed fenced blocks labelled `bash`, `sh`, `shell`, or `zsh`. Bash tool calls, unlabelled blocks, and other languages are excluded.
- **Individual commands + whole block:** multi-command blocks are parsed locally with `sh-syntax` so each top-level command is selectable on its own, followed by a labelled **whole block** option. Pipelines, `&&`/`||` chains, loops, functions, multiline strings, and heredocs stay intact; unparseable blocks stay whole.
- **Controls:**
  - `Up` / `Down`, `PageUp` / `PageDown` — navigate matches (respects `tui.select.*` bindings)
  - `Ctrl+Left` / `Ctrl+Right` — scroll long previews horizontally/by page
  - `Enter` — copy the selected command to clipboard and clear `$$` (never submits as a prompt)
  - `Escape` / `Ctrl+C` — hide the menu while keeping the query editable

Uses Pi's `copyToClipboard()` (TUI-only; remote/headless OSC 52 delivery depends on terminal support). Nothing is ever executed or sent to the model.

## License

MIT — see [LICENSE](./LICENSE).
