# @zle13/pi-bash-guard

A guard and a watchdog for Pi's `bash` tool, both backed by **Jev** (TypeSafe System One, a decision-only classifier), with session-owned background command execution.

- **Guard:** before a risky command runs, Jev judges whether it could cause irreversible loss. Recoverable commands pass; the rest ask you - or are blocked outright in deny mode.
- **Watchdog:** while a command runs, Jev checks periodically whether it is still making progress. Stuck or looping commands are killed; long-lived services are left alone.
- **Background jobs:** run a command asynchronously and keep working. Approval checks, native timeout/process cleanup, and watchdog monitoring stay in the same execution path. Completion wakes the agent without polling.

```sh
pi install npm:@zle13/pi-bash-guard
pi -e npm:@zle13/pi-bash-guard   # try once
```

**0.5.0:** `guard.allowBelow` now defaults to **0.25**, down from 0.5. The threshold only applies to commands that already matched a risky shape, so a mid-range score usually means the pattern does not really apply rather than that the command was verified safe. Expect more dialogs for the 0.25–0.5 band (`find -delete`, `docker system prune`, `git branch -D`); set `guard.allowBelow` back to 0.5 to keep the old behavior - your user-level config can, project configs cannot raise it.

**0.5.0:** a project-level `<cwd>/.pi/bash-guard.json` may now only tighten the guard for its directory. Previously it could set `guard.enabled: false`, add `allowPatterns`, raise `allowBelow`, or repoint `jev.endpoint` - which let any cloned repo switch the guard off, whitelist commands, or send this machine's commands elsewhere. Those keys are now ignored with a warning; put them in `~/.pi/agent/bash-guard.json` instead.

**0.4.1 fixes extension loading for managed installs on Pi 1.x.** Custom endpoints use Pi's exposed built-in provider API rather than a raw SDK subpath. Configuration and guard behavior are unchanged.

## Background commands (0.6.0)

The `bash` tool adds an optional `background` parameter:

```js
await tools.bash({ command: "npm test", background: true, timeout: 600 });
// { status: "running", job_id: "bg-..." }

await tools.bash({ command: "git status", background: false });
// Normal native bash result: { output, exit_code, truncated, wall_time_seconds, ... }
```

- `background: true` returns immediately. A running acknowledgement is not a successful command result.
- Omit `background` to wait normally, automatically yielding after **60 seconds** if still running. The command is not restarted.
- `background: false` forces foreground execution, even past the automatic threshold.
- Use `--bash-background-after 10` to change the threshold for an invocation, or `--bash-background-after 0` to disable automatic backgrounding. Explicit `background: true` still works.
- `timeout` retains Pi's native meaning: seconds from execution start, with no default deadline. Backgrounding does not reset or remove an explicit deadline.
- Foreground completion, nonzero exits, errors, rendering, and programmatic results retain native behavior. **Behavior change:** an ordinary command lasting past the threshold now returns a running acknowledgement rather than its final output. Scripts must handle that shape, or pass `background: false`.

When a job finishes, a `bash-guard-background` custom message reports its ID, command preview, final state, exit code when available, and a bounded output tail (4 KiB / 40 lines) — never the full accumulated output. It is queued as steering while busy and triggers a turn when idle. The agent should continue independent work, or end its turn if nothing remains; it should not poll or rerun the command.

### Seeing what is running

A background acknowledgement is a *final* tool result, so Pi stops that block's own elapsed clock. Left alone, a running job would look finished. Bash Guard re-renders the block from live job state instead, using one 1 Hz tick shared with the row above the editor:

```text
⛨ bash sleep 8; printf 'BACKGROUND_OK\n'  (timeout 20s)
▶ running · 3s · bg-588d7673

# the same block, after the job settles — no new block, no flash
⛨ bash sleep 8; printf 'BACKGROUND_OK\n'  (timeout 20s)
✓ completed · 8s · exit 0

# above the editor, while any job runs
▶ 2 bg · 12s │ 5m03s   npm start
```

State glyphs, identical in the block and the widget row: `▶` running, `◐` cancelling, `✓` completed, `✗` failed, `⊘` cancelled. A failed job names its cause (`timed out after 1s`, `exit 2`, or the watchdog's kill reason). A live job keeps its job ID; settled jobs drop it.

Motion is the advancing clock, not a spinner: the agent's working indicator already owns spinners in the transcript, and a second one would compete with it. The widget row shows the oldest │ newest elapsed plus the newest command, so 16 concurrent jobs still cost one line; it disappears when the last job settles. Nothing animates outside a TUI, and every ticker is disposed on settle, session change, and shutdown.

`--bash-bg-animation off` renders a static snapshot and stops the 1 Hz job tick. The watchdog footer clock is unaffected.

Inspect or cancel with the `bash_jobs` tool:

```js
await tools.bash_jobs({ action: "list" });
await tools.bash_jobs({ action: "status", job_id: "bg-..." });
await tools.bash_jobs({ action: "cancel", job_id: "bg-..." });
// { jobs: [...] }
```

Lists omit output; `status` returns the latest bounded native output snapshot, capped at 40 lines / 4 KiB. A `truncated` flag discloses omitted output. If Pi retained full output, `full_output_path` points to its native file; use `read` to inspect it. No full-output file is promised for short output. Jobs transition through `running`, `cancelling`, `completed`, `failed`, or `cancelled`. Cancel uses Pi's native abort/process-tree cleanup, not graceful service shutdown. Watchdog kills and timeouts report `failed` with their reason.

### Stopping a job yourself

Three ways, depending on who is driving:

- **`ctrl+shift+k`** — confirm and cancel the running job. With several running, a picker lists elapsed time, state, and command. No model turn needed; this is the fast path for stopping your own runaway command.
- **`/bash-jobs`** — the same picker as a command.
- **`bash_jobs` tool** — what the agent uses, from conversation.

All three abort the same way: Pi's kill of the process tree. There is no graceful `SIGTERM` handoff, so a backgrounded server or migration dies at once rather than draining. Cancelling a job you started is expected to do this.

### Lifetime and integration limits

- Up to 16 commands run at once; the 20 most recent *finished background* jobs remain inspectable (a running job is never evicted). IDs are runtime-local, not durable process handles.
- Background jobs detach from the originating turn's abort signal once acknowledged. That covers the automatic and the explicit `background: true` paths alike. Use the controls above to cancel them; aborting a foreground call still kills it.
- **Reload, exit, and suspend all end your jobs.** Reload, shutdown, and session switch/fork/tree-navigation cancel and await owned commands, clear the registry, and suppress unsent completions. A vetoed navigation attempt still cancels jobs. Shutdown waits up to 2s for aborted commands and then proceeds, so a process that ignores its abort signal cannot hang Pi. This is intentional: a background command is owned by the session that started it.
- **A hard kill cannot clean up.** If Pi itself is killed with `SIGKILL`, or the terminal closes, no extension code runs. Pi spawns bash detached, so the command and its children keep running as orphans with no way to reach them from Pi. Run durable work under a service manager or in tmux if you need it to outlive the session.
- Jobs do not survive Pi exiting. Use a live TUI/RPC session; print/JSON or auto-exiting subagents may exit before a result arrives.
- Completion is a custom message, not a second `tool_result`. Other extensions' tool-result-only redaction does not cover it. If the message queue is cleared (for example by Escape), a completion can be lost; the result remains in `bash_jobs` until cleanup/history eviction. Delivery errors are reported when a UI is available.
- The existing watchdog footer continues tracking background commands. No separate terminal overlay or process daemon is added. If the watchdog is disabled, the widget row and `bash_jobs` still show job state.
- Do not combine this with another extension replacing `bash`: one override wins, disabling this package's execution features if it loses. A tool allowlist must include `bash_jobs` if inspection/cancellation is needed. `--no-bash-guard` skips the bash override unless an enforced deny launch policy requires it; this also disables background parameters in that run.

## Approval modes

`guard.approvalMode` decides what happens to a risky command that is not allowed by rules or Jev:

- `"ask"` (default): *Allow once / Allow for this session / Block*. Without a UI, or if the tool call is aborted, it is blocked. "Allow for this session" remembers the exact command string, persisted on the session branch.
- `"deny"`: the command is blocked immediately with the reasons and score in the block message. No dialog is ever shown, and previously saved session approvals are ignored - an old "Allow for this session" cannot bypass deny. Non-risky commands, explicit `allowPatterns`, and Jev-recoverable scores still pass.

### Launch override

```
PI_BASH_GUARD_APPROVAL_MODE=ask|deny
```

A valid value overrides config and session approval modes for the run. A `deny` value is **enforced launch policy**:

- the guard stays enabled no matter what `guard.enabled` says, and regardless of `--no-bash-guard`, saved session toggles, or `/bash-guard off` / `/bash-guard ask` (those commands warn that the guard stays on in deny mode); the watchdog remains independently toggleable;
- the footer and `/bash-guard` reflect the effective state, so `--no-bash-guard` never shows an "off" guard while env deny is in force.

Config-only deny is different: it sets the default escalation behavior, but session `ask`/`deny`/`off` choices still apply. Config `enabled` and the disabling launch flag remain activation gates.

**Invalid values fail closed.** An invalid `PI_BASH_GUARD_APPROVAL_MODE` value is a hard error: it is reported as an error notification, `/bash-guard` shows it, and the guard runs fail-closed in deny mode with the guard pinned on - it never silently falls back to prompting.

## Runtime capability marker

Embeddings that run bash-guard alongside their own extensions can check whether the guard actually loaded and initialized. Pi continues after extension-load errors, so source presence proves nothing. The guard publishes a process-global marker under `Symbol.for("@zle13/pi-bash-guard/runtime")`:

| Field | Meaning |
|---|---|
| `ready` | `true` only after a `session_start` finished initializing config, restored state, watchdog, and the bash override |
| `version` | package version (`""` if unreadable) |
| `approvalMode` | effective escalation mode after environment → session → config resolution |
| `guardEnabled` | effective guard enablement (`true` under enforced env deny) |
| `envEnforced` | `true` when the launch environment pins the guard on |
| `error` | non-empty when the launch environment value was invalid (fail-closed deny) |

Contract for consumers:

- Load `@zle13/pi-bash-guard` **before** the consumer extension: session_start handlers run in load order, so the marker is ready when the consumer's `session_start` reads it.
- Re-read `globalThis[Symbol.for("@zle13/pi-bash-guard/runtime")]` at every check; never cache the object (a runtime reload publishes a fresh one, and shutdown deletes it).
- Treat a missing marker or `ready !== true` as a launch failure. When you launch with `PI_BASH_GUARD_APPROVAL_MODE=deny`, also require `approvalMode === "deny"` and `guardEnabled === true`.
- Jev being unavailable does **not** block readiness: the rules-only guard is fully operational.
- Readiness only. All risk policy stays inside the guard; do not re-derive modes or duplicate enforcement.

`ready` is `false` from factory entry until initialization completes, so a factory that loaded but failed during `session_start` is distinguishable from a module that never loaded.

## Guard

Every `bash` tool call is parsed and matched against a built-in table of risky patterns:

- files: `rm` with `-r`/`-f`/unquoted globs, `find -delete`/`-exec rm`, `truncate`, `shred`, `dd`, `mkfs*`, `wipefs`, `chmod -R`/`chown -R`, `rsync --delete`/`--remove-source-files`
- redirects: a `>`/`>>` onto a database file or a raw device (`: > prod.db`), whatever the command was
- git: `reset --hard`, force pushes (`--force`, `-f`, `+refspec`, `:branch` deletes), `clean -f` (dry runs pass), `checkout --`/`restore`, force `checkout -f`/`switch -f`, `branch -D`, `stash drop/clear`, `filter-branch`/`filter-repo`, `reflog expire`
- data and infra: destructive SQL via `psql`/`mysql`/`sqlite3`, SQL script files (`psql -f`), `terraform destroy`/`apply -auto-approve`, `kubectl delete`, `docker rm/rmi/volume rm/system prune`, `compose down -v`, `helm uninstall`, `aws s3 rm --recursive`/`s3 rb`
- publishing: `npm unpublish`, `gh repo delete`

Matching sees through compound commands, redirects (`>`, `>>`, `2>&1`, `&>`, `<` - the target is not a command word), `$(...)`, backticks, `bash -c`/`sh -c`/`eval`, env assignments, wrappers (`sudo`, `env`, `xargs`, `timeout`, `nohup`, ...), git global options (`-C`, `-c`, ...), and shell control keywords. Quoted text is data: `echo "rm -rf /"` never matches.

Nesting is followed up to 8 levels. Deeper scripts are not inspected, so they are flagged as `nesting-too-deep` and escalated rather than silently allowed - a benign script nested that deep asks once.

The table is a **deny-list**: no match means the command runs immediately. It covers recognizable destructive shapes, not named tools (a script, `rsync --delete`, `helm uninstall`, or Python/Node code that deletes files is not modeled). Treat it as a speed bump that buys a classifier call, not as a sandbox.

Then:

1. Not risky, or matches one of your `allowPatterns`: runs immediately, no classifier call.
2. Risky: Jev scores the probability of irreversible loss. Below `allowBelow` (default 0.25) it runs.
3. Otherwise (high score, Jev error, timeout, malformed answer) it escalates per `approvalMode` (see above): ask mode shows *Allow once / Allow for this session / Block*; deny mode blocks. Without a UI, or if the tool call is aborted, it is blocked. "Allow for this session" remembers the exact command string, persisted on the session branch (restored approvals are ignored in deny mode).

Allowed commands Jev judged get a dim line under them in the transcript, e.g. `⛨ bash-guard: jev p=0.31 recoverable` or `jev p=0.60 allowed by user`. Blocked commands carry the score in their block reason.

Bash's transcript timer starts at actual execution, excluding Jev checks, permission dialogs, and parallel preflight waits. Blocked commands show no execution timer. This also works with the watchdog disabled. The guard registers Pi's local bash tool whenever either component is enabled; if another extension owns bash, its execution timing is left unchanged. Result formatting, collapse behavior, and other tools' renderers are preserved.

Without a Jev classifier the guard runs **rules-only**: every risky command escalates, and a one-time notice says how to enable Jev.

Calibration from live scores: cleanups of a regenerable directory (`rm -rf node_modules`/`dist`) score about 0.2–0.3 and still pass at the default; `find -delete` and `docker system prune` (≈0.35–0.48) now escalate. `rm -rf ~` (≈0.95), `DROP DATABASE` (≈0.84), `rm -rf .git` (≈0.72), `push --force main` (≈0.61), `git clean -fd` (≈0.57), and `reset --hard HEAD~5` (≈0.52) escalate. `git branch -D` (≈0.35) escalates too, since the work moves to the reflog rather than staying put.

`allowBelow` defaulted to 0.5 before 0.5.0. The threshold only applies to commands that already matched a risky shape, so a score near 0.5 means "this pattern probably does not apply here" more often than "verified recoverable" - at that setting the classifier's own uncertainty was enough to wave a command through. Raise it if the extra dialogs are not worth it; lower it to be stricter still.

## Watchdog

The watchdog overrides the `bash` tool with Pi's own local shell operations plus a tracking layer. Each running command keeps a bounded output tail and gets a Jev check at `firstCheckSec` (default 120), then every `intervalSec` (default 300). Each check asks:

- `status`: `progressing`, `waiting`, `stuck`, or `looping`
- `persistent`: is this a long-lived service (dev server, watcher, log tail) operating normally?

A command is killed after `agreeChecks` (default 2) consecutive `stuck`/`looping` checks at or above `confidence` (default 0.8). Its process tree is terminated, the tool result explains why with a redacted output tail, and the agent is steered not to rerun it unchanged. A failed check resets the count.

A persistent service (≥ 0.5) is never killed unless it is `looping`. Instead the agent is steered once to background it, e.g. `nohup ... > /tmp/name.log 2>&1 &`.

The last 10 checks per command are kept: elapsed time, status probabilities, persistent p, and outcome (`agree n/N`, `veto`, `kill`, `failed: <reason>`). They ride in the bash result's `details.bashGuardWatchdog.checks` for the UI and show in `/bash-guard`; the model never sees them.

The watchdog does nothing without a Jev classifier, or when another extension already overrides `bash` (you get a warning; the guard keeps running).

## Jev classifiers

Jev is reached through Pi's built-in classifier API, so your existing Pi credentials work:

| Provider | Model IDs | Authentication |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `~typesafe/jev-latest`, `typesafe/jev-1.13` | `OPENROUTER_API_KEY` or `/login openrouter` |
| `opencode` | `jev-1.13` | `OPENCODE_API_KEY` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `cloudflare-workers-ai` | `typesafe/jev` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |

Unpinned, models are tried in this order. The `typesafe` System One provider accepts both wire model names: `jev-latest`, then `jev-1.13.0`. This also works when its URL and credentials are overridden in Pi's `models.json`, for example to use RelayRouter. The alternate name is derived from the built-in classifier; it does not need a custom chat-model entry.

Timeouts, provider errors, and malformed answers trigger runtime failover to the next available candidate, including OpenRouter. Each candidate is tried at most once per decision, with its own `jev.timeoutMs` budget, so total latency can exceed that budget. Candidates are resolved lazily: an unused fallback provider's authentication cannot delay the preferred endpoint. Availability probes are also cancellation-aware and bounded by `jev.timeoutMs`. The next decision starts with the preferred provider again. A valid answer ends the search regardless of its score; cancellation stops it immediately. If every attempt fails, the guard escalates and the watchdog resets its agreement count. Usage reported by all attempts is accumulated.

Resolution remains lazy, so `/login` takes effect without a restart. Pin one with `jev.model` (`"provider/modelId"`); pinned models retain the existing behavior: no cross-provider failover, and an unavailable pinned model leaves the guard rules-only.

**Privacy:** classifier input goes to whichever provider serves the model. The guard sends the command, matched rule reasons, cwd, git branch, and dirty flag. The watchdog sends the command, cwd, runtime, seconds since output changed, and an output tail. Text is redacted for common secret shapes (API keys, tokens, passwords, Bearer, AWS, JWT, private keys, URL credentials) on a best-effort basis. No conversation content or files are sent.

## Commands

```
/bash-guard                  show effective settings and their sources
/bash-guard ask              enable guard; ask on escalation
/bash-guard deny             enable guard; block on escalation
/bash-guard off              disable guard only
/bash-guard watchdog on|off  watchdog only
pi --no-bash-guard           disable both for one run
```

Guard mode and watchdog are independent: `ask`, `deny`, and `off` never change the watchdog. Each change confirms the effective state, e.g. `Guard: deny · Watchdog: on`. Deny blocks escalations, not all bash commands.

Commands change only this session; they never write config files. Explicit selections persist on the session branch across resume, reload, compaction, and fork, and follow `/tree` navigation. Untouched settings continue using config defaults. New sessions start from config rather than inheriting the previous session's choices. Exact-command approvals remain session-scoped and are ignored in deny mode.

Approval mode precedence is **launch environment → session selection → project config → user config → defaults**. Config `guard.enabled: false` / `watchdog.enabled: false` and `--no-bash-guard` prevent activation; commands warn rather than claim they enabled those components. Enforced launch deny is the exception: the guard stays on, and neither `ask` nor `off` weakens it.

Status shows the effective mode, its source, config/session enablement, the resolved model (or how to enable one), the last classifier failure, session guard decisions, classifier token usage and cost, and recent watchdog checks.

**Breaking changes in 0.3.0:** use `ask` instead of `prompt` in config and the launch environment. The redundant `status` argument and the old `on` and `guard on|off` commands were removed; `off` now affects only the guard. Old boolean-toggle session entries are no longer restored; reselect the desired settings using the new commands. Old `prompt` config values are invalid, and an old `prompt` launch value fails closed in deny mode.

## Footer

Dim to blend with Pi's footer; problems use the warning color. The badge is the guard's effective mode: `ask` or `deny` while the guard runs, `off` otherwise.

```
⛨ BG ask                          guard prompting for risky commands, nothing judged yet
⛨ BG deny                         deny mode; every escalation is blocked
⛨ BG ask 4✓ 1? 1✗                 risky commands: passed by Jev, asked and allowed, blocked
⛨ BG ask ⏱ 3:10 progressing .92   running: elapsed, latest verdict and probability
⛨ BG ask ⏱ 7:05 stuck .88 kill 1/2  1 of 2 agreeing checks needed to kill
⛨ BG ask ⏱ 12:00 service          long-lived service, won't be killed
⛨ BG ask ⏱2 7:05 waiting .81      2 running, showing the oldest
⛨ BG ask rules-only · 2?          no Jev classifier
⛨ BG ask jev ✗ timeout · 4✓       last Jev call failed; clears on next success
⛨ BG ask guard-only · 4✓          watchdog off (guard-only next to any badge)
⛨ BG off · watch-only · ⏱ 3:10    guard off, watchdog running (never shows a misleading ask)
⛨ BG deny guard-only · 1✗         env-enforced deny with the watchdog off
⛨ BG ask ⚠ bash conflict · 4✓     another extension owns the bash override
⛨ BG off                          disabled
```

The tally counts only risky commands, hides zero buckets, and resets each session. While commands run, a ticking clock replaces it.

## Configuration

Set defaults for new sessions in `~/.pi/agent/bash-guard.json`, overridden by `<cwd>/.pi/bash-guard.json`. Edit these files for persistent preferences across sessions; slash commands are session-only overrides. Config is loaded at session start; use `/reload` after editing it. Invalid files are reported and skipped; an invalid merged result falls back to defaults. Defaults, plus example patterns:

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
    "firstCheckSec": 120,
    "intervalSec": 300,
    "confidence": 0.8,
    "agreeChecks": 2
  },
  "jev": {
    "timeoutMs": 6000,
    "model": "openrouter/~typesafe/jev-latest"
  }
}
```

`extraRiskyPatterns` and `allowPatterns` are regexes matched against the full command; allow wins over built-in rules, and invalid regexes are reported and skipped. `guard.approvalMode` is `"ask"` (confirm with the user) or `"deny"` (block all escalations); session selections override this default, the `PI_BASH_GUARD_APPROVAL_MODE` launch override wins over both, and a valid `deny` value also pins the guard on (see Approval modes). `jev.timeoutMs` defaults to 6000ms and applies per attempt. Leave `jev.model` unset for auto-detection and failover.

### Project config may only tighten

`<cwd>/.pi/bash-guard.json` arrives with the working tree, so it is treated as untrusted. It can make the guard stricter for its own directory, never weaker: `guard.enabled: false`, `guard.allowPatterns`, a `guard.allowBelow` above the inherited value, relaxing `approvalMode` from deny to ask, and `jev.endpoint` are ignored and reported where you will see them (a warning at session start, and in `/bash-guard`).

Ignoring `jev.endpoint` also keeps a committed config from choosing where this machine's commands and cwd are sent. Set the endpoint in `~/.pi/agent/bash-guard.json` or through `jev.model`.

Tightening is always honored: `extraRiskyPatterns`, a lower `allowBelow`, a stricter `approvalMode`, and `enabled: true`. Untrusted tuning that cannot loosen the guard (`watchdog`, `jev.timeoutMs`, model pins in your own config) is untouched.

### Custom Jev endpoint

**Added in 0.4.0:** alternate Jev model names, automatic runtime failover, and custom System One endpoints. Existing `jev.model` pins remain single-provider.

To use RelayRouter or another **System One-compatible** provider directly, configure `jev.endpoint` in `bash-guard.json` instead of `jev.model`:

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

The client posts to `<baseUrl>/systemone`. A generic OpenAI chat endpoint is not sufficient. `models` is an ordered list of wire model IDs; omitted, it defaults to `["jev-latest", "jev-1.13.0"]`. Endpoint candidates run first, then the available Pi-registry candidates above, including OpenRouter. If the endpoint credential is missing, registry candidates can still run.

`apiKey` accepts a literal key, `$NAME`, or `${NAME}`. Prefer an environment reference: the variable must exist in the Pi process. Shell commands are not supported. Do not put credentials in the URL. `jev.endpoint` and `jev.model` are mutually exclusive. Endpoint calls reuse Pi's System One SDK, but authenticate with this key rather than `/login`; no change to `models.json` is required. Existing registry-only configurations continue to work. Reload after changing `bash-guard.json`.

## Limits

- Only the `bash` tool is guarded; `!` user commands are not.
- The table is deliberately lenient: plain `rm file`, normal `git push`, and `terraform plan` pass.
- SQL is detected in `-c`/`-e` (psql, mysql) and positional args (sqlite3), not on stdin.
- Quoting inside `$( )` is not tracked for paren balancing, and wrappers are recognized by name, so aliased binaries are not unwrapped.
- Watchdog thresholds use the chosen status's probability, not Jev's self-reported `confidence`.
- Deny mode ignores restored session approvals by design; old "Allow for this session" entries only apply in ask mode.
