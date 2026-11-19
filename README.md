# zle-pi

Independently installable [Pi Coding Agent](https://pi.dev) extensions developed in an npm-workspace monorepo. Each package under [`packages/`](./packages) is self-contained with its own Pi manifest, runtime dependencies, tests, and documentation.

## Extensions

| Package | Docs | npm | License | What it does |
| --- | --- | --- | --- | --- |
| **`@zle13/pi-bash-guard`** | [`packages/bash-guard`](./packages/bash-guard/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-bash-guard)](https://www.npmjs.com/package/@zle13/pi-bash-guard) | [MIT](./LICENSE) | Jev-backed safety guard and stuck-command watchdog for Pi's `bash` tool, plus session-owned background jobs (`background: true` or automatic 60s yield) with a live clickable job widget and `bash_jobs` tool. |
| **`@zle13/pi-codex-auth`** | [`packages/codex-auth`](./packages/codex-auth/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-codex-auth)](https://www.npmjs.com/package/@zle13/pi-codex-auth) | [MIT](./LICENSE) | OpenAI Codex multi-account switcher and 5h/weekly quota monitor integrating [`@loongphy/codex-auth`](https://github.com/loongphy/codex-auth) with Pi's auth, footer, and below-editor quota bar. |
| **`@zle13/pi-editor`** | [`packages/editor`](./packages/editor/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-editor)](https://www.npmjs.com/package/@zle13/pi-editor) | [MIT](./LICENSE) | Vim-style modal prompt editor with a top-border session-name badge, a thinking-color working border trail, and an inline `$$` picker to copy shell commands from recent assistant replies. |
| **`@zle13/pi-footer`** | [`packages/footer`](./packages/footer/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-footer)](https://www.npmjs.com/package/@zle13/pi-footer) | [MIT](./LICENSE) | Responsive 3-line TUI footer (`starship` or `classic` style) showing Git status and line diffs, active toolchain, Codex quota, token/context/cache/speed/cost metrics, model & thinking level, extension statuses, and a live agent work timer (`◷`). |
| **`@zle13/pi-header`** | [`packages/header`](./packages/header/README.md) | Source only (not yet on npm) | [MIT](./LICENSE) | Responsive startup header pairing an olive-green ASCII logo with live keybinding hints resolved from your active `KeybindingsManager`, expandable via `ctrl+o`. |
| **`@zle13/pi-move`** | [`packages/move`](./packages/move/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-move)](https://www.npmjs.com/package/@zle13/pi-move) | [MIT](./LICENSE) | Switch working directories in place (`/move`) and resume, fork, or create sessions with native Git worktree discovery and main-checkout session inheritance. |
| **`@zle13/pi-prompt-snippets`** | [`packages/prompt-snippets`](./packages/prompt-snippets/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-prompt-snippets)](https://www.npmjs.com/package/@zle13/pi-prompt-snippets) | [See notice](./packages/prompt-snippets/NOTICE) | Mix-and-match prompt rules (`Alt+S` or `/snippets`) that prepend or append to your next message and reset after sending, with in-menu editing (`Ctrl+E`) and session prompt auditing (`/snippets-audit`). |
| **`@zle13/pi-recap`** | [`packages/recap`](./packages/recap/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-recap)](https://www.npmjs.com/package/@zle13/pi-recap) | [Apache-2.0](./packages/recap/LICENSE) | Concise progress recaps and next-step tips above the editor after idle time (or via `/recap`), plus automatic subject-focused session naming for new conversations (`/autoname`). |
| **`@zle13/pi-todo`** | [`packages/todo`](./packages/todo/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-todo)](https://www.npmjs.com/package/@zle13/pi-todo) | [MIT](./packages/todo/LICENSE) | Session-scoped task tracking with a `todo` model tool (including `blockedBy` dependencies), `/todos` command, and a live collapsible/clickable progress panel above the editor. |

### Extension highlights

- **[`@zle13/pi-bash-guard`](./packages/bash-guard/README.md)** — Intercepts risky `bash` tool calls (destructive file, Git, SQL, cloud/container, and redirect patterns) and scores irreversible-loss risk via **Jev** (TypeSafe System One, or rules-only fallback) under `ask` or enforced `deny` policy (`PI_BASH_GUARD_APPROVAL_MODE`). Periodically checks running commands for `stuck` or `looping` states (`ask`, `notify-only`, or `auto-stop` watchdog policies) while leaving healthy long-lived services alone. Adds `background` execution (`background: true` or automatic 60s yield on direct calls), a live above-editor job bar with a clickable dropdown and detail drawer, `bash_jobs` tool, `/bash-jobs`, `ctrl+shift+k`, and `/bash-guard`.
- **[`@zle13/pi-codex-auth`](./packages/codex-auth/README.md)** — Connects Pi with [`@loongphy/codex-auth`](https://github.com/loongphy/codex-auth) (`~/.codex/accounts/`). Switch accounts interactively or by alias/index/previous (`-`) with `/codex-auth`, inspect 5-hour and weekly rate limits and credit balances, display a footer badge and subtle 2nd-line quota bar below the editor, watch external account switches live, and sync refreshed OAuth tokens bi-directionally.
- **[`@zle13/pi-editor`](./packages/editor/README.md)** — Replaces the prompt editor with a focused Vim modal subset (`INSERT`/`NORMAL`, motions, counts, `dw`/`cw`/`dd`/`cc`/`D`/`C`, `u`/`ctrl+r` undo/redo, hardware block/beam cursor shapes). Renders the active session title on the top-right border, sweeps a synchronized thinking-color trail around the border while busy, and opens an inline shell-command copy picker when you type `$$` into an empty editor (or run `/copy-command`) to copy individual commands or whole shell fences from the last 10 assistant replies.
- **[`@zle13/pi-footer`](./packages/footer/README.md)** — Renders a 3-line status footer configurable via `/footer` (`starship` or `classic` style): Line 1 shows repo/branch/status/diff metrics, active language runtime, and the `@zle13/pi-codex-auth` quota badge; Line 2 shows input/output tokens, context window usage (`◔ used/window`), cache hit rate, generation speed (`t/s`), session cost, and active model + thinking level; Line 3 shows statuses from other extensions (such as `@zle13/pi-bash-guard`) alongside a persistent active agent work timer (`◷`) that notifies elapsed work duration after each response.
- **[`@zle13/pi-header`](./packages/header/README.md)** — Renders a side-by-side startup banner with an olive-green ASCII logo and live shortcut hints queried from Pi's `KeybindingsManager`. Press `ctrl+o` (or your configured expand key) to toggle the full 2-column shortcut reference, or run `/builtin-header` to restore Pi's default header for the session.
- **[`@zle13/pi-move`](./packages/move/README.md)** — Run `/move`, `/move <branch>`, or `/move <path>` to switch directories without restarting Pi. Discovers Git worktrees, lets linked worktrees inherit and fork sessions from the main checkout, and supports forking the current conversation into a new directory with full message history.
- **[`@zle13/pi-prompt-snippets`](./packages/prompt-snippets/README.md)** — Press `Alt+S` or run `/snippets` to toggle lightweight markdown rules that prepend or append to your next message and automatically reset after sending. Discovers bundled, global (`~/.pi/agent/snippets/`), and trusted project (`.pi/snippets/`) snippets, includes an in-menu editor (`Ctrl+E`) to create, override, hide, or delete snippets without leaving Pi, and provides `/snippets-audit` to analyze recent session prompts against snippet usage.
- **[`@zle13/pi-recap`](./packages/recap/README.md)** — Generates a one-sentence summary of the session goal/state and a next-step tip above the editor after at least 3 user prompts and 2 minutes of uninterrupted idle time (or immediately via `/recap`), without polluting model context. Also gives new unnamed sessions a concise 3–6 word subject title after the first completed response (or on demand via `/autoname`).
- **[`@zle13/pi-todo`](./packages/todo/README.md)** — Opt-in per session via `/todos`. When enabled, exposes a `todo` tool (`create`, `update`, `list`, `get`, `delete`, `clear` with `blockedBy` cycle validation and `activeForm` labels) and renders a live collapsible/clickable progress overlay above the editor reconstructed from session branch snapshots across `/reload`, resume, fork, and compaction.

## Check what's published

Packages in this monorepo are versioned and published independently under the [`@zle13` npm scope](https://www.npmjs.com/search?q=%40zle13) and listed in the [Pi package gallery](https://pi.dev/packages) using the `"pi-package"` keyword:

- **Published on npm:** `@zle13/pi-bash-guard`, `@zle13/pi-codex-auth`, `@zle13/pi-editor`, `@zle13/pi-footer`, `@zle13/pi-move`, `@zle13/pi-prompt-snippets`, `@zle13/pi-recap`, and `@zle13/pi-todo` (the badges in the table above reflect the live npm version).
- **Source-only (not yet published to npm):** `@zle13/pi-header` — try or install it from a local checkout.
- **Workspace vs. npm versions:** Each `packages/<name>/package.json` tracks the current workspace version on `main`, which may include unreleased commits ahead of the latest npm tarball.

To check the live published version of any package (or compare all workspace packages against npm) from your terminal:

```bash
# Check one package on npm
npm view @zle13/pi-bash-guard version

# Compare every workspace package in a local clone against npm
for pkg in packages/*; do
  name=$(node -p "require('./$pkg/package.json').name")
  local_ver=$(node -p "require('./$pkg/package.json').version")
  npm_ver=$(npm view "$name" version 2>/dev/null || echo "unpublished")
  printf "%-28s workspace: %-8s npm: %s\n" "$name" "$local_ver" "$npm_ver"
done
```

## Try or install

### Prerequisites

- **Node.js** and **npm**
- **[Pi Coding Agent](https://pi.dev)** (`pi`) installed and available on your `PATH` (see the [official Pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md); `@zle13/pi-recap` requires Pi `1.0.2+`)
- For **`@zle13/pi-codex-auth`** only: [`@loongphy/codex-auth`](https://github.com/loongphy/codex-auth) installed globally (`npm install -g @loongphy/codex-auth`)

### Try an extension for one session

Use `pi -e` (`--extension`) to load a package for a single run without modifying your settings:

```bash
# Try a published package directly from npm
pi -e npm:@zle13/pi-bash-guard

# Or try any package from a local clone of this repository
pi -e ./packages/bash-guard
pi -e ./packages/header
```

If you already have another extension installed that registers the same command or tool name (such as another `todo` or `recap` package), pass `-ne` (`--no-extensions`) to test the package in isolation:

```bash
pi -ne -e ./packages/todo
```

### Install from npm

Install any published package into your personal Pi configuration (`~/.pi/agent/settings.json`):

```bash
pi install npm:@zle13/pi-bash-guard
pi install npm:@zle13/pi-codex-auth
pi install npm:@zle13/pi-editor
pi install npm:@zle13/pi-footer
pi install npm:@zle13/pi-move
pi install npm:@zle13/pi-prompt-snippets
pi install npm:@zle13/pi-recap
pi install npm:@zle13/pi-todo
```

Add `-l` (`--local`) to write the package declaration to the current project's `.pi/settings.json` instead (loaded after project trust is granted), or append `@<version>` to pin a specific release.

> **Migrating from `@lanlance/pi-recap`:** Remove the upstream package first (`pi remove npm:@lanlance/pi-recap`) before installing `@zle13/pi-recap` so both packages do not register `/recap` simultaneously.

### Install from a local checkout

To use `@zle13/pi-header` or run unreleased changes on `main`, clone this repository, install workspace dependencies once, and point `pi install` at the package directory:

```bash
git clone https://github.com/LeZH13/zle-pi.git
cd zle-pi
npm install

# Install into ~/.pi/agent/settings.json
pi install ./packages/header

# Or install into the current project's .pi/settings.json
pi install -l ./packages/header
```

Pi loads local packages directly from their resolved path without running `npm install` for them, so running `npm install` in the repository root ensures third-party runtime dependencies (such as `shell-quote`, `marked`, and `sh-syntax`) are available.

### Manage installed packages

```bash
pi list                        # List configured packages
pi update --extensions         # Reconcile and update installed packages
pi remove npm:@zle13/pi-move   # Remove a configured package
pi config                      # Enable or disable individual package resources
```

Inside an active Pi session, run `/reload` to pick up settings or local source changes; restart Pi when testing startup lifecycle or header changes.

## Related project

I use my fork of [pi-interactive-subagents](https://github.com/LeZH13/pi-interactive-subagents) to delegate work to subagents in Pi. It lives in a separate repository and is optional: none of the extensions here require it.

## Contributor setup

Clone the repository and install the monorepo dependencies from the workspace root:

```bash
git clone https://github.com/LeZH13/zle-pi.git
cd zle-pi
npm install
```

Run repository-wide checks:

```bash
npm test
npm run typecheck
```

Work on and verify an individual package:

```bash
# Run one package's test suite and typecheck
npm test --workspace @zle13/pi-bash-guard
npm run typecheck --workspace @zle13/pi-bash-guard

# Inspect the files that will be included in the published npm tarball
npm pack --dry-run --workspace @zle13/pi-bash-guard

# Exercise the package live in Pi
pi -e ./packages/bash-guard
```

Each package under `packages/<name>/` owns its `package.json` (with explicit `pi` manifest paths and Pi host packages in `peerDependencies`), `extensions/`, package-local helpers (`src/` or `lib/`), `test/`, and `README.md`. See [`AGENTS.md`](./AGENTS.md) for architecture boundaries, Pi resource contracts, testing expectations, and versioning policy.

## License

Original project code in this repository is licensed under the **[MIT License](./LICENSE)** (`Copyright (c) 2026 zle13`).

Packages adapted from upstream projects preserve their original licenses and attribution notices:

- **[`@zle13/pi-recap`](./packages/recap)** — Licensed under **[Apache-2.0](./packages/recap/LICENSE)**. Adapted from [`L2ncE/pi-recap`](https://github.com/L2ncE/pi-recap) (`Copyright 2026 L2ncE`). See [`packages/recap/LICENSE`](./packages/recap/LICENSE) and [`packages/recap/NOTICE`](./packages/recap/NOTICE).
- **[`@zle13/pi-todo`](./packages/todo)** — Licensed under **[MIT](./packages/todo/LICENSE)**. Adapted from [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono) (`Copyright 2026 juicesharp`). See [`packages/todo/LICENSE`](./packages/todo/LICENSE) and [`packages/todo/NOTICE`](./packages/todo/NOTICE).
- **[`@zle13/pi-prompt-snippets`](./packages/prompt-snippets)** — [MIT](./packages/prompt-snippets/LICENSE) covers this project's original contributions only. See the [upstream attribution and license note](./packages/prompt-snippets/NOTICE). Adapted from original work by [Amos Blomqvist](https://github.com/amosblomqvist) in [`amosblomqvist/pi-config`](https://github.com/amosblomqvist/pi-config). See [`packages/prompt-snippets/README.md`](./packages/prompt-snippets/README.md).
- **[`@zle13/pi-footer`](./packages/footer)** — Licensed under **[MIT](./LICENSE)**. Design inspired by [`@henryqw/pi-footer`](https://github.com/HenryQW/pi-harness/tree/main/extensions/pi-footer) and Starship prompt themes.
