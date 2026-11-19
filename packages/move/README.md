# @zle13/pi-move

Pi extension to switch working directories and resume, fork, or create sessions—with native Git worktree support.

## Installation

```bash
pi install npm:@zle13/pi-move
```

## Usage

```text
/move              # Open interactive hub (worktrees, recent dirs, inherit from main)
/move <branch>     # Jump directly to a worktree by branch name (e.g. /move feat-auth)
/move <path>       # Move to any directory with smart history autocomplete
```

## Features

- **Interactive Hub:** Run `/move` without arguments to pick from repository Git worktrees and recent directories.
- **Worktree Session Inheritance:** When inside a linked worktree (e.g. via Herdr), run `/move` to adopt and fork any session from the main repo checkout.
- **Seamless Context Forking:** Moving to an empty worktree or directory lets you fork your current conversation, rebinding `cwd` while preserving complete message history.
- **Smart Autocomplete:** Surfaces worktree branches, recent directories, and filesystem paths as you type.

## License

MIT — see [LICENSE](./LICENSE).
