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
* **Full Autocomplete:** Rich tab-completion for `/codex-auth` subcommands, toggles, and registered account aliases.
* **Pi Footer Status Badge:** Displays a compact status badge (`codex: work (plus)`) directly in Pi's footer.
* **Dedicated Quota Widget:** Renders a subtle 2nd-line bar below the editor showing 5-hour and weekly rate limits with faint hairline separation.
* **Live File Watcher:** Automatically detects external `codex-auth switch` calls from other terminals and updates Pi immediately.
* **Bi-directional Refresh Write-back:** When Pi refreshes an expired OAuth token, the new tokens are written back to `~/.codex/auth.json` and its snapshots so external CLI tools never break.
* **Strict Secret Redaction:** All tokens, refresh tokens, and private account IDs are completely protected and masked in logs/UI.

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `/codex-auth` | Open the interactive TUI account picker dialog |
| `/codex-auth switch <alias>` | Switch directly to an account by alias, masked email, or key |
| `/codex-auth <alias>` | Shortcut to switch directly to an account |
| `/codex-auth status` | Show all registered accounts and 5h / weekly quota reset countdowns |
| `/codex-auth sync` | Manually force a bi-directional sync between `~/.codex` and Pi |
| `/codex-auth widget on\|off` | Toggle the quota progress line below the editor |
| `/codex-auth footer on\|off` | Toggle the footer status badge |

---

## License

MIT
