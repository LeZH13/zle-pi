# @zle-pi/move

A [Pi](https://pi.dev) extension that introduces the `/move` command to smoothly switch the working directory and session during an interactive Pi workflow.

## Features

- **Directory Switching**: Switch working directory with the required `/move <path>` argument.
- **Recent Directory & Path Autocomplete**:
  - Automatically suggests your top 5 most recently active project directories from Pi session history on empty input (`/move `).
  - Flexible matching: search recent directories by substring, directory basename, path prefix, regex pattern, or fuzzy subsequence as you type.
  - Smart filesystem autocomplete for subdirectories, parent directories (`../`), and home paths (`~/`).
- **Session Continuity**:
  - When sessions already exist in the destination directory, displays a menu offering to either **start a fresh new session** (`[+] Start a new session`) or **resume an existing session** with recent activity timestamps and message previews.
  - Automatically initializes a new session when moving to a directory without existing sessions.
- **Directory Creation**: Prompts to create the destination directory if it does not yet exist.
- **Session Runtime Rebinding**: Completely rebuilds cwd-bound tools (bash, read, edit, write), context files, and resources for the target directory.

## Installation

### Project-local (recommended during workspace development)

Add the package to your `.pi/settings.json`:

```json
{
  "packages": [
    "./packages/move"
  ]
}
```

Or test temporarily with:

```bash
pi -e ./packages/move
```

### Global (available across all projects)

Install into global settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": [
    "/path/to/zle-pi/packages/move"
  ]
}
```

## Usage

### Moving with a path argument

```text
/move ./packages/my-new-package
/move ../another-project
/move ~/workspace/backend
/move /var/www/site
```

Press `Tab` or type after `/move ` to see autocomplete suggestions:

```text
/move 
┌────────────────────────────────────────────────────────┐
│ ~/zle_ws/pi-interactive-subagents/     Recent (25m ago)│
│ ~/zle_ws/pi-learn/                     Recent (1h ago) │
│ ~/.pi/                                 Recent (yesterday)│
│ ../                                    Parent directory│
│ ~/                                     Home directory  │
│ packages/                              Directory       │
└────────────────────────────────────────────────────────┘
```

A destination path is required. Invoking `/move` without one shows the usage error `/move <path>`.

### Session Selection

When moving to a directory with existing sessions, `/move` displays a session selector:

```text
Select session in ~/workspace/backend:
> [+] Start a new session
  [●] Refactor auth middleware (2h ago) [most recent]
  [ ] Fix database connection timeout (yesterday)
  [ ] Initial project setup (4d ago)
```

- Select `[+] Start a new session` to start clean in the new directory.
- Select any listed session to resume where you left off.

## Development

Run tests and typecheck:

```bash
npm test --workspace @zle-pi/move
npm run typecheck --workspace @zle-pi/move
```
