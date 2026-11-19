# @zle13/pi-footer

A responsive 3-line custom footer for [Pi Coding Agent](https://pi.dev) showing Git status and diff stats, active language runtime, Codex quota, session token/cost/speed metrics, model & thinking level, extension statuses, and an active agent work timer.

Inspired by [`@henryqw/pi-footer`](https://github.com/HenryQW/pi-harness/tree/main/extensions/pi-footer) and Starship prompt themes. Uses [Nerd Font](https://www.nerdfonts.com/) glyphs for icons (``, `⬡`, ``).

## Installation

```bash
pi install npm:@zle13/pi-footer
pi -e npm:@zle13/pi-footer   # try for one session
```

Then launch Pi in TUI mode or run `/reload`.

## Styles

### Starship *(default)*

```text
zle-pi on  main [!?] +1527 -693 via ⬡ v26.7.0         codex #1 · 5h 95% · 7d 99%
↑ 263.9k ↓ 29.0k · ◔ 99.4k/200k · ↺ 98.9% ·  34.3 t/s · $ 6.406    openai/gpt-5.4 • high
custom-extension-status                                                ◷ 16m 22s
```

### Classic

```text
zle-pi ·  main [!1+2~1?3↑1]                           codex #1 · 5h 95% · 7d 99%
↑ 263.9k ↓ 29.0k · ◔ 99.4k/200k · ↺ 98.9% ·  34.3 t/s · $ 6.406    openai/gpt-5.4 • high
custom-extension-status                                                ◷ 16m 22s
```

## What's shown

- **Line 1 — Identity & Codex quota**
  - **Left:** directory/repo name and Git branch (or `@<commit>` for detached HEAD). **Starship** shows status badges (`!` modified, `?` untracked, `+` staged, `=` conflicts, `↑`/`↓`/`⇕` ahead/behind, plus rebase/merge state), line diff stats (`+added -deleted`), and active toolchain (`Node`, `Python`, `Rust`, `Go`, `Bun`, `Deno`). **Classic** shows compact file-count badges (`!+~?↑↓`).
  - **Right:** automatically promotes `@zle13/pi-codex-auth`'s status badge (`codex #1 · 5h 95% · 7d 99%`) and keeps it visible on narrow terminals.
- **Line 2 — Session metrics & model**
  - **Left:** cumulative input/output tokens (`↑`/`↓`), context usage (`◔ used/window`), latest cache hit rate (`↺`), average generation speed (` t/s`), and estimated session cost (`$`).
  - **Right:** active `provider/model • thinking` colored to match Pi's active theme thinking-level colors (`off` through `max`, with animated rainbow for `ultra`).
- **Line 3 — Extension statuses & active timer**
  - **Left:** statuses from other extensions (`ctx.ui.setStatus`), sorted by extension name and separated by `|` with original styling preserved.
  - **Right:** persistent active agent work timer (`◷ <duration>`) ticking live during runs, pausing during interactive prompts, persisting across reloads, and posting a `worked for <duration>` notification when a response finishes.

## Commands

| Command | Description |
| --- | --- |
| `/footer` | Open interactive selector for style and enable/disable |
| `/footer starship` / `/footer classic` | Switch Line 1 layout style |
| `/footer style [starship\|classic]` | View or set layout style |
| `/footer toggle` / `on` / `off` | Toggle or set the custom footer |

## Configuration

Preferences persist in `~/.pi/agent/footer.json`:

```json
{
  "enabled": true,
  "style": "starship"
}
```

## License

MIT — see [LICENSE](./LICENSE).
