# @zle13/pi-bash-guard

Guarded, monitored, and background-capable `bash` tool for [Pi Coding Agent](https://pi.dev), backed by **Jev** (TypeSafe System One classifier, with a rules-only fallback).

- **Guard:** intercepts risky shell commands and scores irreversible-loss risk via Jev; recoverable commands pass, while risky ones prompt (`ask`) or block (`deny`).
- **Watchdog:** periodically checks running commands for `stuck` or `looping` states while leaving healthy long-lived services alone.
- **Background jobs:** runs commands asynchronously (`background: true` or automatic 60s yield) with a live clickable widget, `bash_jobs` tool, and completion wakeups without polling.

## Installation

```bash
pi install npm:@zle13/pi-bash-guard
pi -e npm:@zle13/pi-bash-guard   # try for one session
```

## Commands & shortcuts

| Command / Flag | Description |
| --- | --- |
| `/bash-guard` | Open the interactive Guard, Watchdog, and Status menu |
| `/bash-guard status` | Show effective settings, sources, counters, and recent watchdog checks |
| `/bash-guard ask` / `deny` / `off` | Set guard mode for this session (does not change watchdog) |
| `/bash-guard watchdog on\|off` | Toggle the watchdog while remembering its stop mode |
| `/bash-guard watchdog ask\|notify-only\|auto-stop` | Set watchdog stop mode and enable it |
| `/bash-jobs` / `ctrl+shift+k` | Pick and cancel running background jobs |
| `/bash-jobs toggle` | Expand or collapse the above-editor background jobs list |
| `pi --no-bash-guard` | Disable both guard and watchdog for one run (unless env `deny` is enforced) |
| `pi --bash-background-after <sec\|0>` | Override automatic background yield threshold (`0` disables auto-yield) |
| `pi --bash-bg-animation off` | Render a static job snapshot instead of the 1 Hz elapsed clock |

Slash commands apply only to the current session (persisted on the session branch across reload, resume, compaction, and fork) and never write config files.

## Guard

Every `bash` tool call is parsed—seeing through pipes, compound commands, redirects, `$(...)`, backticks, `bash -c`/`eval`, env assignments, wrappers (`sudo`, `env`, `xargs`, `timeout`, `nohup`, …), and git global options up to 8 nesting levels—and checked against built-in risky patterns:

- **Files:** `rm` with `-r`/`-f`/unquoted globs, `find -delete`/`-exec rm`, `truncate`, `shred`, `dd`, `mkfs*`, `wipefs`, `chmod -R`/`chown -R`, `rsync --delete`/`--remove-source-files`
- **Redirects:** `>`/`>>` onto a database file or raw device (e.g. `: > prod.db`)
- **Git:** `reset --hard`, force push (`-f`, `--force`, `+refspec`, `:branch`), `clean -f`, `checkout --`/`restore`, `checkout -f`/`switch -f`, `branch -D`, `stash drop`/`clear`, `filter-branch`/`filter-repo`, `reflog expire`
- **Data & infra:** destructive SQL (`psql`/`mysql`/`sqlite3`, `psql -f`), `terraform destroy`/`apply -auto-approve`, `kubectl delete`, `docker rm`/`rmi`/`volume rm`/`system prune`, `compose down -v`, `helm uninstall`, `aws s3 rm --recursive`/`s3 rb`
- **Publishing:** `npm unpublish`, `gh repo delete`

Quoted strings are treated as data (`echo "rm -rf /"` never matches). Commands nested deeper than 8 levels are flagged `nesting-too-deep` and escalated.

**Decision flow:**

1. Safe commands or commands matching `allowPatterns` run immediately with no classifier call.
2. Risky commands are scored by Jev. Scores below `guard.allowBelow` (default `0.25`) run with a dim transcript note (e.g. `⛨ bash-guard: jev p=0.22 recoverable`).
3. Higher scores, Jev failures, or **rules-only** mode (when no Jev classifier is configured) escalate according to `guard.approvalMode`:
   - `"ask"` *(default)*: **Allow once / Allow for this session / Block**. Blocks automatically if no UI is available or the call is aborted.
   - `"deny"`: blocks immediately with reasons and score, ignoring prior session approvals.

### Enforced launch policy

```bash
PI_BASH_GUARD_APPROVAL_MODE=ask|deny
```

Setting `PI_BASH_GUARD_APPROVAL_MODE=deny` pins the guard **on** in deny mode for the entire run—overriding config, `--no-bash-guard`, saved session toggles, and `/bash-guard ask|off`. Invalid values fail closed in enforced deny mode and surface an error notification.

Precedence: **launch env → session command → project config → user config → defaults**.

## Watchdog

While a command runs, the watchdog keeps a bounded output tail and queries Jev at `firstCheckSec` (default `120s`), then every `intervalSec` (default `300s`), checking status (`progressing`, `waiting`, `stuck`, `looping`) and whether it is a `persistent` service.

A stop recommendation fires after `agreeChecks` (default `2`) consecutive `stuck`/`looping` verdicts at or above `confidence` (default `0.8`). Healthy persistent services (`≥ 0.5`) are never killed unless `looping`; instead, the agent is steered once to background them.

`watchdog.stopMode` is independent of `guard.approvalMode`:

- **`"ask"`** *(default)*: prompts with command, elapsed time, and Jev's verdict (**Stop command** / **Keep running**); dismissing or headless mode leaves it running.
- **`"notify-only"`**: warns once without stopping.
- **`"auto-stop"`**: terminates the process tree, reports the redacted tail, and steers the agent not to rerun unchanged. (Cannot be enabled by untrusted project config.)

The watchdog requires a Jev classifier and does not run if another extension already overrides `bash`.

## Background jobs

The `bash` tool accepts an optional `background` boolean:

```js
await tools.bash({ command: "npm test", background: true, timeout: 600 });
// { status: "running", job_id: "bg-..." }

await tools.bash({ command: "git status", background: false });
// Native bash result: { output, exit_code, truncated, ... }
```

- **`background: true`**: returns a running acknowledgement immediately.
- **Omitted**: direct `bash` calls wait normally and **auto-yield after 60 seconds** if still running; nested calls (e.g. codemode `tools.bash()`) stay foreground by default so scripts expecting `output`/`exit_code` don't break.
- **`background: false`**: forces foreground execution past the 60s threshold.
- **`timeout`**: keeps Pi's native meaning (seconds from start; not reset on yield).

When a job finishes, a compact `bash-guard-background` completion panel is delivered (queued as steering while busy, or triggering a turn when idle) with Pi's native model-facing output (2,000 lines / 50 KiB limit + native temp file on truncation). Press `ctrl+o` to expand full output.

### Live status & cancellation

Transcript tool blocks update in place with a shared 1 Hz elapsed clock, and active jobs appear in a single-line widget above the editor:

```text
⛨ bash sleep 8; printf 'BACKGROUND_OK\n'  (timeout 20s)
● Running in background · 0:03 · bg-588d7673

# same block after settling:
✓ Completed · 0:08 · exit 0

# above the editor while jobs run:
 ▸ 3 background jobs │ ● npm start 5:03 │ ● sleep 60 0:38 │ ● npm test 0:12
```

Glyphs: `●` running, `◐` cancelling, `✓` completed, `✗` failed, `⊘` cancelled. In fullscreen TUI, click the widget row to open the job dropdown and click any job to inspect its tail or cancel inline. From the keyboard, use `ctrl+shift+k`, `/bash-jobs`, or `/bash-jobs toggle`.

The agent can inspect or cancel jobs via the `bash_jobs` tool (`action: "list" | "status" | "cancel"`). All cancellation paths kill the process tree immediately via Pi's native abort cleanup.

**Lifetime notes:** Up to 16 concurrent jobs (20 most recent finished jobs kept in history). Jobs detach from the originating turn's abort signal once acknowledged, but are **session-owned**: reload, session switch/fork/tree navigation, and shutdown cancel them (waiting up to 2s on shutdown). If Pi is killed with `SIGKILL` or the terminal closes, detached child processes can outlive Pi—use `tmux` or a service manager for durable services.

## Jev classifiers

Jev uses Pi's built-in classifier API and existing credentials, tried lazily in order with automatic failover on timeout, error, or malformed output:

| Provider | Model IDs | Authentication |
| --- | --- | --- |
| `typesafe` | `jev-latest`, `jev-1.13.0` | `TYPESAFE_API_KEY` (or `models.json` override) |
| `openrouter` | `~typesafe/jev-latest`, `typesafe/jev-1.13` | `OPENROUTER_API_KEY` or `/login openrouter` |
| `opencode` | `jev-1.13` | `OPENCODE_API_KEY` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `cloudflare-workers-ai` | `typesafe/jev` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |

Pin a single provider/model with `jev.model` (`"provider/modelId"`) to disable cross-provider failover.

**Privacy:** Guard sends the command, matched rules, `cwd`, git branch, and dirty flag. Watchdog sends the command, `cwd`, runtime, idle duration, and output tail. Common secret shapes (API keys, tokens, Bearer, AWS, JWT, private keys, URL credentials) are redacted best-effort. No conversation content or files are sent.

## Configuration

Set user defaults in `~/.pi/agent/bash-guard.json` and per-repo overrides in `<cwd>/.pi/bash-guard.json` (run `/reload` after edits):

```json
{
  "guard": {
    "enabled": true,
    "approvalMode": "ask",
    "allowBelow": 0.25,
    "extraRiskyPatterns": ["^make\\s+publish"],
    "allowPatterns": ["^rm -rf /tmp/"]
  },
  "watchdog": {
    "enabled": true,
    "stopMode": "ask",
    "firstCheckSec": 120,
    "intervalSec": 300,
    "confidence": 0.8,
    "agreeChecks": 2
  },
  "jev": {
    "timeoutMs": 6000
  }
}
```

- `extraRiskyPatterns` and `allowPatterns` are full-command regexes; `allowPatterns` override built-in rules.
- **Project config can only tighten:** `<cwd>/.pi/bash-guard.json` is treated as untrusted—it may add `extraRiskyPatterns`, lower `allowBelow`, or tighten `approvalMode` to `"deny"`, but cannot disable the guard, add `allowPatterns`, raise `allowBelow`, relax `approvalMode`, enable `watchdog.stopMode: "auto-stop"`, or set `jev.endpoint`. Ignored keys trigger a startup warning.

### Custom System One endpoint

To route directly to a System One-compatible endpoint (e.g. RelayRouter) instead of `jev.model`, configure `jev.endpoint` in `~/.pi/agent/bash-guard.json` (mutually exclusive with `jev.model`):

```json
{
  "jev": {
    "timeoutMs": 6000,
    "endpoint": {
      "baseUrl": "https://api.relayrouter.ai/v1",
      "apiKey": "$RELAYROUTER_JEV_API_KEY",
      "models": ["jev-1.13.0", "jev-latest"]
    }
  }
}
```

Posts to `<baseUrl>/systemone` (a generic OpenAI chat endpoint will not work). `apiKey` accepts `$NAME`, `${NAME}`, or a literal key; endpoint candidates run first before falling back to available Pi registry candidates.

<details>
<summary>Footer status reference</summary>

Dim by default; warnings use the theme warning color.

```text
⛨ BG ask                                             guard prompting, nothing judged yet
⛨ BG deny                                            deny mode; every escalation is blocked
⛨ BG ask · 4✓ 1? 1✗                                  risky tally: passed by Jev, asked & allowed, blocked
⛨ BG ask · ⏱ 3:10 progressing .92                    running: elapsed, verdict, probability
⛨ BG ask · ⏱ 7:05 stuck .88 (1/2 agree)              1 of 2 checks toward stop recommendation
⛨ BG ask · ⏱ 12:00 service                           long-lived service, won't be killed
⛨ BG ask · ⏱3 2⚠ · pytest 7:05 stuck .88 (1/2 agree) 3 running, 2 warnings, highest-priority shown
⛨ BG ask · rules-only · 2?                           no Jev classifier available
⛨ BG ask · jev ✗ timeout · 4✓                        last Jev call failed (clears on next success)
⛨ BG ask · guard-only · 4✓                           watchdog disabled
⛨ BG off · watch-only · ⏱ 3:10                       guard off, watchdog running
⛨ BG ask · ⚠ bash conflict · 4✓                      another extension owns the bash override
⛨ BG off                                             disabled
```

</details>

<details>
<summary>Runtime capability marker (for embedders)</summary>

Publishes process-global readiness under `globalThis[Symbol.for("@zle13/pi-bash-guard/runtime")]`:

| Field | Meaning |
| --- | --- |
| `ready` | `true` only after `session_start` finished initializing config, state, watchdog, and bash override |
| `version` | Package version (`""` if unreadable) |
| `approvalMode` | Effective mode (`"ask"` or `"deny"`) |
| `guardEnabled` | Effective guard enablement (`true` under enforced env deny) |
| `envEnforced` | `true` when launch env pins the guard on |
| `error` | Non-empty if `PI_BASH_GUARD_APPROVAL_MODE` was invalid (fail-closed deny) |

Load `@zle13/pi-bash-guard` **before** consumer extensions, re-read the symbol on every check (never cache across reloads), and treat missing or `ready !== true` as a launch failure. Jev unavailability does not block readiness (rules-only mode is still ready).

</details>

<details>
<summary>Limits & edge cases</summary>

- Only the `bash` tool is guarded; interactive `!` user commands are not.
- The risky-pattern table is a speed bump for recognizable destructive shapes, not a sandbox—custom scripts or Python/Node code that delete files are not modeled. Plain `rm file`, normal `git push`, and `terraform plan` pass.
- SQL detection covers `-c`/`-e` (`psql`/`mysql`), `-f` (`psql`), and positional args (`sqlite3`), not stdin.
- Quoting inside `$( )` is not tracked for paren balancing, and aliased wrapper binaries are not unwrapped.
- Do not pair with another extension that replaces `bash`; whichever wins disables the other's execution features. If using a tool allowlist, include `bash_jobs` for inspection/cancellation.
- Background completions are custom messages (not `tool_result`), so tool-result-only redactors do not see them; clearing the message queue can drop a notification while results remain inspectable via `bash_jobs`.

</details>

## License

MIT — see [LICENSE](./LICENSE).
