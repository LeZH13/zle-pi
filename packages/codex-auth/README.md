# @zle13/pi-codex-auth

An OpenAI Codex multi-account switcher and quota monitor extension for **Pi Coding Agent** (`@earendil-works/pi-coding-agent`).

Directly connects Pi with your [`codex-auth`](https://github.com/loongphy/codex-auth) accounts, providing seamless account switching, quota tracking, live file watching, and bi-directional token synchronization.

---

## Prerequisites & Dependencies

> **Required CLI Dependency:**  
> This extension relies on **`codex-auth`** ([`@loongphy/codex-auth`](https://github.com/loongphy/codex-auth)) to manage OpenAI OAuth account credentials, aliases, and snapshots under `~/.codex/accounts/`.

Install `codex-auth` globally via npm:

```bash
npm install -g @loongphy/codex-auth
```

Authenticate your OpenAI Codex accounts using `codex-auth`:

```bash
# Login and register your accounts
codex-auth login

# (Optional) Set friendly aliases
codex-auth alias set <query> work
codex-auth alias set <query> personal
```

---

## Installation in Pi

Install this package into Pi:

```bash
pi install npm:@zle13/pi-codex-auth
```

Or install from a local clone:

```bash
pi install /path/to/zle-pi/packages/codex-auth
```

---

## Features

* **Interactive Switcher:** Run `/codex-auth` in interactive mode to pick and switch between accounts using a clean TUI selector.
* **codex-auth v0.3.0 & Schema 4 Ready:** Full support for `codex-auth v0.3.0`, `schema_version: 4`, product-level plan naming (`business`, `enterprise`), and new JSON API contracts.
* **Previous Account Shortcut (`-`):** Jump back and forth between previous accounts with `/codex-auth -` or `/codex-auth switch -`.
* **Flexible Selectors:** Switch by friendly alias, email substring, display row number (e.g. `/codex-auth 1`), or account name.
* **Quota & Credits Monitoring:** Displays 5h and weekly quota percentages, reset countdowns, credit balances, and reset credits in status views and picker dialogs.
* **Full Autocomplete:** Rich tab-completion for `/codex-auth` subcommands (`switch`, `list`, `alias`, `sync`, `widget`, `footer`), previous shortcut (`-`), and registered accounts.
* **Alias Management:** Set or clear aliases directly from Pi via `/codex-auth alias set <query> <alias>` and `/codex-auth alias clear <query>`.
* **Pi Footer Status Badge:** Displays a compact status badge (`codex: work (plus)`) directly in Pi's footer.
* **Dedicated Quota Widget:** Renders a subtle 2nd-line bar below the editor showing remaining 5-hour and weekly rate limits (100% when unused, 0% when depleted, consistent with `codex-auth`) with faint hairline separation.
* **Live File Watcher:** Automatically detects external `codex-auth switch` calls from other terminals and updates Pi immediately.
* **Safe Bi-directional Token Sync:** When Pi refreshes an expired OAuth token, the new tokens are written back to the account's managed snapshot and active auth without cross-account contamination.
* **Strict Secret Redaction:** All tokens, refresh tokens, and private account IDs are completely protected and masked in logs/UI.
* **Persistent Display Preferences:** Toggle settings (`/codex-auth widget on|off` and `/codex-auth footer on|off`) are automatically saved to `~/.pi/agent/codex-auth.json` and persist across sessions.

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `/codex-auth` | Open the interactive TUI account picker dialog |
| `/codex-auth -` | Jump directly back to the previously active account |
| `/codex-auth switch <query>` | Switch directly by alias, email fragment, row number (`1`), account name, or `-` |
| `/codex-auth <query>` | Shortcut to switch directly to an account or previous (`-`) |
| `/codex-auth list` / `/codex-auth status` | Show all registered accounts, 5h & weekly quotas, and credit balances |
| `/codex-auth alias set <query> <alias>` | Set an alias for the matched account |
| `/codex-auth alias clear <query>` | Clear an alias for the matched account |
| `/codex-auth sync` | Manually force a bi-directional sync between `~/.codex` and Pi |
| `/codex-auth widget on\|off` | Toggle the quota progress line below the editor |
| `/codex-auth footer on\|off` | Toggle the footer status badge |

---

## License

MIT
