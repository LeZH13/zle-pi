# @zle13/pi-editor

A Vim-style prompt editor with a session-name badge and a shell-command clipboard picker. Unnamed sessions render the native top border with no badge.

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
- **Working / scroll states**: the working spinner (`── ◐ Working…`) and scroll indicator (`↑ N more`) keep their native positions on the left/center. While a native working, retry, compaction, or branch-summary indicator is active, a softly fading trail in the current thinking-level color sweeps clockwise over the border fill, native working spinner/text, session name, and Vim mode label: left-to-right across the top, then right-to-left across the bottom, with invisible side transitions. The trail uses a lighter shade of the current thinking-level color (or Bash-mode color) on dark themes, and a deeper shade on light themes, fading smoothly into the unchanged base border color. No rainbow or unrelated accent colors are used. The circuit takes six seconds and the tail spans one-third of the virtual perimeter; the native working spinner/text, session-name badge, and INSERT/NORMAL text (including pending Vim keys) light up as that same trail passes through their columns, then fade back to their native styling. NORMAL retains its bold emphasis. The spinner keeps its native frame animation—there is no separate pulse. Retry/compaction/branch-summary status text, scroll labels, and editor content stay steady. Idle borders are unchanged, with no animation timer. Autocomplete and the command-copy menu are not animated.
- **Narrow terminals / long names**: names truncate with `…`; if fewer than 8 columns remain for the badge, the native border wins.
- **Conflicts**: if another custom editor is already active (e.g. Zentui), this extension defers and notifies once per session. Both the `$$` trigger and `/copy-command` require this extension to own the editor.

```text
named idle:    ────────────────────── my-session ──
named working: ── ◐ Working… ────────── my-session ──
named scroll:  ─────── ↑ 3 more ──────── my-session ──
unnamed:       ────────────────────────── (native)
```

## Copy shell commands

Type **`$$` into an empty editor in INSERT mode** to show an inline command-copy menu—no Enter needed. **The editor stays visible and retains focus, with `$$` still in it.** Delete either leading `$` and the menu disappears; restore the prefix to show it again. Text after `$$` filters command text case-insensitively (for example, **`$$git`**). Ordinary Left/Right and deletion keys keep editing the prefix/query.

The first `$` remains ordinary input until the second consecutive `$`; `$HOME`, dollars inside an existing prompt, NORMAL-mode Vim `$`, an initial bracketed paste, and dialog input do not activate copy mode. You can paste filter text after deliberately activating `$$`. To enter a literal initial `$$`, paste it instead of typing it.

**`/copy-command`** enters the same inline mode by inserting `$$` into an empty editor. It requires this extension to own the main editor and refuses to overwrite an existing draft.

The menu scans the **last ten assistant messages on the current session branch**, newest first, and includes **only closed code blocks labelled `bash`, `sh`, `shell`, or `zsh`** (case-insensitive; extra fence metadata is allowed). **Bash tool calls are not candidates.** Unlabelled fences, `text`, `console`, other programming languages, inline code, thinking, tool results, and error/aborted assistant messages are excluded. Tool-call-only assistant messages still count toward the ten-message window. This is explicit shell-language filtering, not semantic validation of command safety. Ask the model to use labelled `bash` fences for commands you want to copy.

When a block contains multiple top-level shell statements, the menu offers **each command individually**, in source order, followed by an explicitly labelled **whole block** option. For example, a block with `git status`, `git diff --stat`, and `git log -5` offers all three separately plus the original block. Filtering searches both individual commands and full blocks. Single-command blocks appear only once. Parsing happens locally; a brief loading indicator may appear, and Enter during loading never submits the query or copies unseen content.

- **Up/Down**: choose a snippet; **PageUp/PageDown**: move by a list page. These respect your `tui.select.*` keybindings.
- **Enter**: copy the selected snippet and clear `$$` plus the query after success. An empty/no-match menu never submits the query as a prompt; neither do queued follow-up keys.
- **Escape/Ctrl+C**: hide the menu, leaving the prefix/query editable in INSERT mode. Editing shows it again; Enter while hidden reopens the preview without copying unseen content. A second Escape enters NORMAL mode; a second Ctrl+C retains Pi's clear action.
- **Ctrl+Left/Ctrl+Right**: scroll a long preview backward/forward by a page. Plain Left/Right remain editor cursor movement.
- **R0** marks the newest assistant message, **R1** the previous one, and so on. The preview shows its language and line count.

Even a single match shows a preview before copying. Clipboard failures leave the prefix/query available for retry. Edits made during a pending clipboard write are never erased by its later completion. Multiline command units stay intact: pipelines, `&&`/`||` chains, continuations, loops, conditionals, functions, subshells, quoted multiline strings, and heredocs are not split internally. A shell parser (`sh-syntax`, based on mvdan/sh) identifies statement boundaries; unparseable blocks, unsupported dialect syntax, and interleaved heredocs that cannot be separated remain available only as whole blocks. Bash-compatible parsing is used for `bash`, `sh`, and `shell`; Zsh parsing is experimental. Source slicing preserves command text rather than reformatting it. Individually copied statements may still depend on earlier setup (`cd`, variable assignments, or function definitions); use the whole-block option when that context is needed. Fence markers and Markdown structural indentation are removed by the Markdown parser; command indentation is preserved and line endings are normalized to LF. Shell prompt `$` markers are **not** stripped. Preview-only escaping makes terminal control characters visible without changing copied text. Nothing is executed or sent to the model. No matches or cancellation leave the clipboard unchanged.

Copying uses Pi's public `copyToClipboard()` utility. Native clipboard failures are reported; remote/headless terminal clipboard delivery via OSC 52 may be best effort and depends on terminal/multiplexer support. This is a terminal-UI-only feature, not an RPC/print-mode clipboard tool.

### Changes in 0.5.0

The `$$` / `/copy-command` picker now offers individual top-level commands from multi-command shell fences, plus a labelled whole-block option. Compound commands remain intact; blocks that cannot be split reliably stay whole. Existing filter and copy keybindings are unchanged. The first selection in a splittable block is now its first command rather than the entire block; choose **whole block** to retain the previous copy behavior.

### 0.4.1 changes

The working border now has a circling single-hue gradient trail derived from the native thinking-level color, including the working spinner/text, session name, and Vim mode label in that same moving trail while preserving the editor layout and NORMAL-mode emphasis. It stops when the native busy indicator clears and releases its timer when the editor is replaced, reloaded, or shut down. There are no new commands or settings.

An initial manually typed `$$` is now reserved for editable command-copy mode in INSERT mode. The menu stays attached to the editor rather than replacing it, and only shell code blocks are eligible—not Bash tool calls. Paste literal `$$` when needed. Existing NORMAL-mode `$` motions and Pi's `!`/`!!` Bash input are unchanged.

## Modal editing

The main prompt editor starts in **INSERT** mode. Escape enters **NORMAL** mode (and dismisses an open copy menu or completion first). Escape cancels a pending normal-mode command; otherwise, in normal mode it retains Pi's interrupt action. Insert mode keeps Pi's normal typing, submission (`enter`), and newline (`ctrl+j`). Unowned controls such as `ctrl+c` and `ctrl+d` still go to Pi.

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

The bottom border shows `── NORMAL ───` or `── INSERT ───` aligned on the bottom-left with bold emphasis in normal mode, as well as pending keys such as `── NORMAL 3d ───`.

### Cursor shapes

The editor automatically distinguishes modes using the terminal's hardware cursor:
- **Normal mode**: Solid block cursor (`\x1b[2 q` steady block, accompanied by software inverse video).
- **Insert mode**: Vertical line cursor (`\x1b[6 q` steady beam/bar), with software inverse highlighting stripped so the vertical bar renders cleanly.
- **Shutdown / exit**: Restores the terminal cursor style back to the user's default (`\x1b[0 q`) and restores hardware cursor visibility.

## License

MIT — see [LICENSE](./LICENSE).
