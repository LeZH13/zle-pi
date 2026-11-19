# zle-pi

Independently installable [Pi Coding Agent](https://pi.dev) extensions in an npm-workspace monorepo. Each package under [`packages/`](./packages) is self-contained with its own Pi manifest, runtime dependencies, tests, and README.

## Extensions

| Package | Docs | npm | License | What it does |
| --- | --- | --- | --- | --- |
| **`@zle13/pi-bash-guard`** | [`bash-guard`](./packages/bash-guard/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-bash-guard)](https://www.npmjs.com/package/@zle13/pi-bash-guard) | [MIT](./LICENSE) | Risky-command guard and stuck-command watchdog backed by Jev, plus session-owned background bash jobs with a live widget and `bash_jobs` tool. |
| **`@zle13/pi-codex-auth`** | [`codex-auth`](./packages/codex-auth/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-codex-auth)](https://www.npmjs.com/package/@zle13/pi-codex-auth) | [MIT](./LICENSE) | OpenAI Codex multi-account switcher and 5h/weekly quota monitor integrating [`@loongphy/codex-auth`](https://github.com/loongphy/codex-auth) with Pi. |
| **`@zle13/pi-editor`** | [`editor`](./packages/editor/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-editor)](https://www.npmjs.com/package/@zle13/pi-editor) | [MIT](./LICENSE) | Vim-style modal prompt editor with a session-name top border, thinking-color working trail, and inline `$$` shell-command clipboard picker. |
| **`@zle13/pi-footer`** | [`footer`](./packages/footer/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-footer)](https://www.npmjs.com/package/@zle13/pi-footer) | [MIT](./LICENSE) | Responsive 3-line TUI footer (`starship` or `classic`) showing Git status/diffs, active runtime, Codex quota, session metrics, model/thinking level, and an active work timer. |
| **`@zle13/pi-header`** | [`header`](./packages/header/README.md) | Source only | [MIT](./LICENSE) | Side-by-side startup banner with an olive-green ASCII logo and live keybinding hints from `KeybindingsManager`, expandable via `ctrl+o`. |
| **`@zle13/pi-move`** | [`move`](./packages/move/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-move)](https://www.npmjs.com/package/@zle13/pi-move) | [MIT](./LICENSE) | Switch working directories in place (`/move`) and resume, fork, or create sessions with native Git worktree discovery. |
| **`@zle13/pi-prompt-snippets`** | [`prompt-snippets`](./packages/prompt-snippets/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-prompt-snippets)](https://www.npmjs.com/package/@zle13/pi-prompt-snippets) | [See notice](./packages/prompt-snippets/NOTICE) | Mix-and-match prompt rules (`Alt+S` / `/snippets`) prepended or appended to your next message, with in-menu editing (`Ctrl+E`) and `/snippets-audit`. |
| **`@zle13/pi-recap`** | [`recap`](./packages/recap/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-recap)](https://www.npmjs.com/package/@zle13/pi-recap) | [Apache-2.0](./packages/recap/LICENSE) | Concise progress recaps above the editor after idle time (or `/recap`), plus automatic subject-focused session naming (`/autoname`). |
| **`@zle13/pi-todo`** | [`todo`](./packages/todo/README.md) | [![npm](https://img.shields.io/npm/v/@zle13/pi-todo)](https://www.npmjs.com/package/@zle13/pi-todo) | [MIT](./packages/todo/LICENSE) | Session-scoped task tracking (`/todos`) with a `todo` model tool (`blockedBy` dependencies) and a collapsible live progress panel. |

All packages except `@zle13/pi-header` (source-only) are published independently on npm under [`@zle13`](https://www.npmjs.com/search?q=%40zle13) and listed in the [Pi package gallery](https://pi.dev/packages). Workspace versions on `main` may include unreleased changes ahead of npm.

## Quick start

### Prerequisites

- **Node.js**, **npm**, and **[Pi Coding Agent](https://pi.dev)** (`pi` on your `PATH`; `@zle13/pi-recap` requires Pi `1.0.2+`)
- For `@zle13/pi-codex-auth` only: [`@loongphy/codex-auth`](https://github.com/loongphy/codex-auth) installed globally (`npm install -g @loongphy/codex-auth`)
- For `@zle13/pi-footer` icons: a [Nerd Font](https://www.nerdfonts.com/) in your terminal

### Install from npm

Install any published package into `~/.pi/agent/settings.json` (pass `-l` to install into the current project's `.pi/settings.json`, or append `@<version>` to pin):

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

### Try for one session

Load any package without modifying your settings (add `-ne` to isolate from conflicting extensions):

```bash
pi -e npm:@zle13/pi-bash-guard
pi -ne -e ./packages/todo
```

### Install from a local checkout

Required for `@zle13/pi-header` or unreleased changes on `main`:

```bash
git clone https://github.com/LeZH13/zle-pi.git
cd zle-pi
npm install

pi install ./packages/header      # personal (~/.pi/agent/settings.json)
pi install -l ./packages/header   # project-local (.pi/settings.json)
```

Running `npm install` at the repo root installs third-party runtime dependencies (`shell-quote`, `marked`, `sh-syntax`) needed when Pi loads local packages directly.

### Manage packages

```bash
pi list                        # List configured packages
pi update --extensions         # Reconcile and update installed packages
pi remove npm:@zle13/pi-move   # Remove a configured package
pi config                      # Enable or disable individual resources
```

Run `/reload` inside Pi to pick up settings or local changes; restart Pi when testing startup lifecycle or header changes.

## Related project

I also maintain a fork of [pi-interactive-subagents](https://github.com/LeZH13/pi-interactive-subagents) for delegating work to subagents in Pi. It is separate and optional—none of the extensions here require it.

## Development

From the repository root after `npm install`:

```bash
# Repository-wide checks
npm test
npm run typecheck

# Single-package checks and tarball inspection
npm test --workspace @zle13/pi-bash-guard
npm run typecheck --workspace @zle13/pi-bash-guard
npm pack --dry-run --workspace @zle13/pi-bash-guard

# Live trial in Pi
pi -e ./packages/bash-guard
```

Each package under `packages/<name>/` owns its manifest, extension entry points, local helpers, tests, and README. See [`AGENTS.md`](./AGENTS.md) for package boundaries, Pi contracts, and versioning policy.

## License

Original code in this repository is licensed under the **[MIT License](./LICENSE)** (`Copyright (c) 2026 zle13`).

Adapted packages preserve their original licenses and attribution notices:

- **[`@zle13/pi-recap`](./packages/recap)** — **[Apache-2.0](./packages/recap/LICENSE)**, adapted from [`L2ncE/pi-recap`](https://github.com/L2ncE/pi-recap) (`Copyright 2026 L2ncE`). See [`LICENSE`](./packages/recap/LICENSE) and [`NOTICE`](./packages/recap/NOTICE).
- **[`@zle13/pi-todo`](./packages/todo)** — **[MIT](./packages/todo/LICENSE)**, adapted from [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono) (`Copyright 2026 juicesharp`). See [`LICENSE`](./packages/todo/LICENSE) and [`NOTICE`](./packages/todo/NOTICE).
- **[`@zle13/pi-prompt-snippets`](./packages/prompt-snippets)** — [MIT](./packages/prompt-snippets/LICENSE) covers original contributions by zle13; adapted from [Amos Blomqvist](https://github.com/amosblomqvist)'s [`amosblomqvist/pi-config`](https://github.com/amosblomqvist/pi-config). See [`NOTICE`](./packages/prompt-snippets/NOTICE).
- **[`@zle13/pi-footer`](./packages/footer)** — **[MIT](./LICENSE)**, inspired by [`@henryqw/pi-footer`](https://github.com/HenryQW/pi-harness/tree/main/extensions/pi-footer) and Starship prompt themes.
