# @zle13/pi-footer

A responsive, rich 3-line custom footer extension for Pi Coding Agent displaying repository identity, Git status badges, line diff metrics, active toolchain runtime, Codex account & quota, session metrics, active model thinking level, and live agent execution time.

Inspired by [`@henryqw/pi-footer`](https://github.com/HenryQW/pi-harness/tree/main/extensions/pi-footer) and Starship prompt themes, tailored for the `@zle13/pi` ecosystem.

---

## Installation

```bash
pi install npm:@zle13/pi-footer
```

Or install locally from source:

```bash
pi install -l ./packages/footer
```

Then launch Pi in TUI mode or run `/reload`.

---

## Layout Styles

The footer renders 3 lines directly below the input editor. Line 1 supports two configurable styles: **Starship** (prompt-styled identity with diff metrics and runtime info) and **Classic** (standard repository identity).

### Starship Style (`style: "starship"`)

Renders a terminal prompt-like Line 1 styled after Starship and Zentui:

```text
zle-pi on  main [!?] +1527 -693 via ⬡ v26.7.0         codex #1 · 5h 95% · 7d 99%
↑ 263.9k ↓ 29.0k · ↺ 98.9% ·  34.3 t/s · $ 6.406 · ◔ 49.7%    gpt-5.6-sol • high
custom-extension-status                                                ◷ 16m 22s
```

- **Directory:** Current directory or repository name in bold cyan.
- **Git Branch:** `on  <branch>` in bold purple. Detached HEAD renders `on  @<commit>`.
- **Git Status Badges:** `[!?]` in bold red. Indicates modified (`!`), untracked (`?`), staged (`+`), conflicts (`=`), and ahead/behind (`↑`/`↓`/`⇕`). Also displays active operations like `REBASING 1/3`.
- **Git Diff Metrics:** `+added -deleted` lines from `git diff HEAD --numstat` (e.g. `+1527` in bold green and `-693` in bold red).
- **Runtime:** `via <symbol> <version>` for active toolchain in current directory (e.g. `⬡ v26.7.0` for Node.js, ` v3.12` for Python, `󱘗 v1.76.0` for Rust, ` v1.22.0` for Go, ` v1.1.20` for Bun, ` v1.40` for Deno).
- **Codex Quota:** Preserved on the right in `#b5bd68`.

### Classic Style (`style: "classic"`)

Standard 3-line layout:

```text
zle-pi ·  main [!1+2~1?3↑1]                           codex #1 · 5h 95% · 7d 99%
↑ 263.9k ↓ 29.0k · ↺ 98.9% ·  34.3 t/s · $ 6.406 · ◔ 49.7%    gpt-5.6-sol • high
custom-extension-status                                                ◷ 16m 22s
```

- Repository identity with compact file badges (`!conflicts`, `+staged`, `~unstaged`, `?untracked`, `↑ahead`, `↓behind`).

---

## Line Details

### Line 1: Identity & Quota
- **Left:** Repository identity according to active style (**Starship** or **Classic**).
- **Right:** Codex account and quota status:
  - Automatically discovered from `@zle13/pi-codex-auth` (`"codex-auth"` status key).
  - Styled with `#b5bd68`.
  - Displays account number `#1` along with compact 5-hour and 7-day quota percentages: `codex #1 · 5h 95% · 7d 99%`.
  - Preserved on the right even when terminal width narrows.

### Line 2: Session Metrics & Model/Thinking
- **Left:** Cumulative usage metrics across the active session:
  - `↑ <tokens> ↓ <tokens>`: Total input and output tokens cleanly separated by a single space.
  - `↺ <percent>%`: Cache read hit rate from the latest assistant message.
  - ` <tps> t/s`: Average generation speed (tokens per second) across assistant turns in the user prompt using the Nerd Font bolt ``.
  - `$ <cost>`: Estimated cumulative session cost.
  - `◔ <context>%`: Context window utilization percentage.
- **Right:** Active model ID and thinking level.
  - Model name in dim text with bullet separator `•`.
  - Thinking level styled following Pi's editor thinking colors (`theme.getThinkingBorderColor`):
    - `off`: `thinkingOff` (dark gray / light gray)
    - `minimal`: `thinkingMinimal` (subtle gray)
    - `low`: `thinkingLow` (slate blue)
    - `medium`: `thinkingMedium` (soft blue / teal)
    - `high`: `thinkingHigh` (lavender / plum)
    - `xhigh`: `thinkingXhigh` (bright purple / magenta)
    - `max`: `thinkingMax` (neon pink / deep ruby)
    - `ultra`: 5-color animated rainbow
  - Automatically adapts across dark, light, and custom user themes.

### Line 3: External Statuses & Active Agent Timer
- **Left:** Preserves any statuses set by other extensions via `ctx.ui.setStatus(...)` (excluding Codex which is promoted to Line 1). Producer ANSI styles, glyphs, and spacing are preserved.
- **Right:** Active agent work timer `◷ <duration>`:
  - Tracks cumulative execution time spent actively running agent turns (`agent_start` → `agent_settled`).
  - Automatically pauses during interactive user prompts (`ui_prompt_start` / `ui_prompt_end`).
  - Live 1-second interval update while the agent is running.
  - Persisted in session entries (`pi-footer:agent-work`), preserving elapsed time across session reloads.
  - On narrow terminals, left extension statuses truncate first to ensure the timer remains visible.

---

## Commands

- **/footer**: Opens interactive TUI selector to switch styles or toggle footer on/off.
- **/footer starship**: Switch to Starship style.
- **/footer classic**: Switch to Classic style.
- **/footer style [starship|classic]**: Configure layout style.
- **/footer toggle**: Toggle custom footer on or off.
- **/footer on** / **/footer off**: Enable or disable the custom footer.

---

## Configuration

Settings are persisted across sessions in `~/.pi/agent/footer.json`:

```json
{
  "enabled": true,
  "style": "starship"
}
```

---

## License

MIT
