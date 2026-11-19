# @zle13/pi-move

Switch working directories in place in [Pi Coding Agent](https://pi.dev) and resume, fork, or create sessions—with native Git worktree discovery.

## Installation

```bash
pi install npm:@zle13/pi-move
pi -e npm:@zle13/pi-move   # try for one session
```

## Usage

```text
/move              # Open interactive hub (worktrees, recent dirs, inherit from main)
/move <branch>     # Jump directly to a worktree by branch name (e.g. /move feat-auth)
/move <path>       # Move to any directory with history and path autocomplete
```

## Features

- **Interactive hub:** run `/move` without arguments to pick from repository Git worktrees and recent directories.
- **Worktree session inheritance:** inside a linked worktree (e.g. via `git worktree`), adopt and fork any session from the main checkout.
- **Context forking:** moving to an empty worktree or directory lets you fork the current conversation, rebinding `cwd` while preserving message history.
- **Smart autocomplete:** surfaces worktree branches, recent directories, and filesystem paths as you type.

## License

MIT — see [LICENSE](./LICENSE).
