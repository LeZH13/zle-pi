# @zle13/pi-recap

Idle progress recaps and automatic subject-focused session naming for [Pi Coding Agent](https://pi.dev). Adapted from [L2ncE/pi-recap](https://github.com/L2ncE/pi-recap).

Requires **Pi 1.0.2+**. Runs only in interactive TUI mode.

## Installation

```bash
pi install npm:@zle13/pi-recap
pi -e npm:@zle13/pi-recap   # try for one session
```

> **Migrating from `@lanlance/pi-recap`:** remove the upstream package first (`pi remove npm:@lanlance/pi-recap`) so both packages do not register `/recap` simultaneously. Upstream recap metadata is not migrated.

## How it works

### Idle recaps

After at least 3 user prompts and **2 uninterrupted minutes of idle time** following a completed agent run, a concise summary appears above the editor:

```text
※ recap: OAuth callback validation fixed and tests pass. Next, get review sign-off before merging.
```

- **Concise & actionable:** one short sentence on the goal/current state plus a brief next-step tip (or an open question when no clear next step exists).
- **Non-intrusive:** stored as a UI widget and non-context session metadata—it is **not** compaction and never enters future model context.
- **Idle-aware:** arms only after fully settled responses (not while tools or approval dialogs are pending). Typing or terminal activity resets the countdown; new work hides the old recap immediately and cancels any in-flight generation. A subtle animated **Generating recap…** badge shows while generating.

### Automatic session naming

New, initially empty sessions automatically receive a short descriptive title after their first completed response:

```text
OAuth callback validation
```

- **Subject-focused:** compact 3–6 word labels (capped at 60 code points / 6 words) matching the conversation language, derived from the session goal, user messages, and touched tools—never progress narration. Overlong outputs retry once and are otherwise skipped (never silently truncated).
- **Respectful:** applies once to unnamed new sessions only; existing `/name`/`--name` titles, resumed sessions, forks, and clones are left untouched (use `/autoname` for those).
- Integrates natively with Pi's session picker and `@zle13/pi-editor`'s top-border badge.

## Commands

| Command | Description |
| --- | --- |
| `/recap` | Generate and display a recap immediately (bypasses prompt threshold and idle delay) |
| `/autoname` | Generate and apply a replacement session title immediately (even if already named or `autoName` is `false`) |
| `/name <text>` | Pi's built-in command for an exact manual title |

`/recap` and `/autoname` take no arguments and decline if the agent or another recap/title request is already running.

## Configuration

Add an optional `recap` block to `~/.pi/agent/settings.json` (or trusted project `.pi/settings.json`):

```json
{
  "recap": {
    "model": "provider/model-id",
    "maxWords": 50,
    "minTurns": 3,
    "idleDelaySeconds": 120,
    "placement": "above",
    "autoName": true
  }
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `model` | Active session model | Shared model for recaps and naming (`provider/model-id` preferred; no fallback if explicitly set and unavailable) |
| `maxWords` | `50` | Maximum words in a recap (longer output is trimmed with `…`) |
| `minTurns` | `3` | User prompts required before the first automatic recap |
| `idleDelaySeconds` | `120` | Uninterrupted idle seconds before automatic recap generation |
| `placement` | `"above"` | `"above"` or `"below"` the editor |
| `autoName` | `true` | Enable automatic naming for new sessions (`/autoname` always remains available) |
| `prompts.recap` | Built-in | Custom system prompt for recaps (plain-text single line; validation still applies) |
| `prompts.name` | Built-in | Custom system prompt for titles (60 code-point / 6-word cap still enforced) |

## Safety, exclusions & cost

- **TUI-only:** no generation, naming, widgets, or metadata writes occur in print, JSON, or RPC modes.
- **Subagent-safe:** registers nothing when `PI_SUBAGENT_ID` or `PI_SUBAGENT_SESSION` is set, leaving child subagent sessions untouched.
- **Race-safe:** only one side-call runs at a time; requests cancel on new input, navigation, reload, or shutdown, and fingerprint checks prevent stale results from overwriting newer state.
- **Extra requests & privacy:** recaps and naming make **additional model requests** using bounded, branch-aware conversation excerpts (excluding thinking blocks and images). Configure a cheaper `recap.model` to minimize cost. Side-call usage is not counted in Pi's main-session totals.

## License & attribution

Apache-2.0 — adapted from **pi-recap by L2ncE**, inspired by Claude Code's recap UI. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
