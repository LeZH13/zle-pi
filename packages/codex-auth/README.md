# @zle13/pi-codex-auth

OpenAI Codex multi-account switcher and 5-hour/weekly quota monitor for [Pi Coding Agent](https://pi.dev), integrating [`@loongphy/codex-auth`](https://github.com/loongphy/codex-auth) with Pi's auth, footer, and below-editor quota bar.

## Prerequisites

Install [`@loongphy/codex-auth`](https://github.com/loongphy/codex-auth) globally and register your accounts:

```bash
npm install -g @loongphy/codex-auth
codex-auth login

# Optional: set friendly aliases
codex-auth alias set <query> work
codex-auth alias set <query> personal
```

## Installation

```bash
pi install npm:@zle13/pi-codex-auth
pi -e npm:@zle13/pi-codex-auth   # try for one session
```

## Features

- **Fast switching & autocomplete:** switch via interactive TUI picker (`/codex-auth`), alias, email substring, row number (`/codex-auth 1`), or previous-account toggle (`/codex-auth -`), with full tab completion.
- **Live quota & credit tracking:** displays remaining 5-hour and weekly rate limits, reset countdowns, and credit balances—refreshed at session start and after Codex responses (throttled to 90s; force anytime with `/codex-auth refresh`).
- **Footer badge & below-editor bar:** shows a compact status badge (`codex #work · 5h 95% · 7d 99%`) in Pi's footer (promoted to Line 1 by `@zle13/pi-footer`) and a subtle quota line below the editor. Toggle settings persist in `~/.pi/agent/codex-auth.json`.
- **Live file watcher:** detects external `codex-auth` switches from other terminals and updates Pi immediately.
- **Bi-directional OAuth sync:** writes refreshed tokens back to the active managed account snapshot safely without cross-account leaks, redacting all tokens and private IDs from logs and UI.

## Commands

| Command | Description |
| --- | --- |
| `/codex-auth` | Open the interactive TUI account picker |
| `/codex-auth -` | Switch back to the previously active account |
| `/codex-auth <query>` / `switch <query>` | Switch by alias, email fragment, row number, account name, or `-` |
| `/codex-auth list` / `status` | Show all accounts, 5h & weekly quotas, and credit balances |
| `/codex-auth alias set <query> <alias>` | Set an alias for an account |
| `/codex-auth alias clear <query>` | Clear an account's alias |
| `/codex-auth sync` | Manually sync credentials between `~/.codex` and Pi |
| `/codex-auth refresh` | Fetch the active account's current quota immediately |
| `/codex-auth widget on\|off` | Toggle the quota bar below the editor |
| `/codex-auth footer on\|off` | Toggle the footer status badge |

## License

MIT — see [LICENSE](./LICENSE).
