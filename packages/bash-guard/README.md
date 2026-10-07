# @zle13/pi-bash-guard

A guard and a watchdog for Pi's `bash` tool, both backed by **Jev** (TypeSafe System One, a decision-only classifier).

- **Guard:** before a risky command runs, Jev judges whether it could cause irreversible loss. Recoverable commands pass; the rest ask you.
- **Watchdog:** while a command runs, Jev checks periodically whether it is still making progress. Stuck or looping commands are killed; long-lived services are left alone.

```sh
pi install npm:@zle13/pi-bash-guard
pi -e npm:@zle13/pi-bash-guard   # try once
```

## Guard

Every `bash` tool call is parsed and matched against a built-in table of risky patterns:

- files: `rm` with `-r`/`-f`/unquoted globs, `find -delete`/`-exec rm`, `truncate`, `shred`, `dd`, `mkfs*`, `wipefs`, `chmod -R`/`chown -R`
- git: `reset --hard`, force pushes and `:branch` deletes, `clean -f` (dry runs pass), `checkout --`/`restore`, `branch -D`, `stash drop/clear`
- data and infra: destructive SQL via `psql`/`mysql`/`sqlite3`, `terraform destroy`/`apply -auto-approve`, `kubectl delete`, `docker rm/rmi/volume rm/system prune`, `aws s3 rm --recursive`/`s3 rb`
- publishing: `npm unpublish`, `gh repo delete`

Matching sees through compound commands, `$(...)`, backticks, `bash -c`/`sh -c`/`eval`, env assignments, wrappers (`sudo`, `env`, `xargs`, `timeout`, `nohup`, ...), git global options (`-C`, `-c`, ...), and shell control keywords. Quoted text is data: `echo "rm -rf /"` never matches.

Then:

1. Not risky, or matches one of your `allowPatterns`: runs immediately, no classifier call.
2. Risky: Jev scores the probability of irreversible loss. Below `allowBelow` (default 0.5) it runs.
3. Otherwise (high score, Jev error, timeout, malformed answer) it escalates: *Allow once / Allow for this session / Block*. Without a UI, or if the tool call is aborted, it is blocked. "Allow for this session" remembers the exact command string, persisted on the session branch.

Allowed commands Jev judged get a dim line under them in the transcript, e.g. `⛨ bash-guard: jev p=0.31 recoverable` or `jev p=0.60 allowed by user`. Blocked commands carry the score in their block reason.

Only bash's call rendering is decorated; result rendering and other tools' renderers remain unchanged, including their collapse behavior.

Without a Jev classifier the guard runs **rules-only**: every risky command escalates, and a one-time notice says how to enable Jev.

Calibration from live scores: routine cleanups (`rm -rf node_modules`/`dist`, `find -delete`, `docker system prune`) score about 0.2–0.48 and pass. `rm -rf ~` (≈0.95), `DROP DATABASE` (≈0.84), `rm -rf .git` (≈0.72), `push --force main` (≈0.61), `reset --hard HEAD~5` (≈0.52), and `git clean -fd` (≈0.57) escalate; `git branch -D` (≈0.35) passes as reflog-recoverable. Lower `allowBelow` to be stricter.

## Watchdog

The watchdog overrides the `bash` tool with Pi's own local shell operations plus a tracking layer. Each running command keeps a bounded output tail and gets a Jev check at `firstCheckSec` (default 120), then every `intervalSec` (default 300). Each check asks:

- `status`: `progressing`, `waiting`, `stuck`, or `looping`
- `persistent`: is this a long-lived service (dev server, watcher, log tail) operating normally?

A command is killed after `agreeChecks` (default 2) consecutive `stuck`/`looping` checks at or above `confidence` (default 0.8). Its process tree is terminated, the tool result explains why with a redacted output tail, and the agent is steered not to rerun it unchanged. A failed check resets the count.

A persistent service (≥ 0.5) is never killed unless it is `looping`. Instead the agent is steered once to background it, e.g. `nohup ... > /tmp/name.log 2>&1 &`.

The last 10 checks per command are kept: elapsed time, status probabilities, persistent p, and outcome (`agree n/N`, `veto`, `kill`, `failed: <reason>`). They ride in the bash result's `details.bashGuardWatchdog.checks` for the UI and show in `/bash-guard status`; the model never sees them.

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

Unpinned, the first available model in this order is used. It is re-resolved lazily, so `/login` takes effect without a restart. Pin one with `jev.model` (`"provider/modelId"`); a pinned model that is unavailable leaves the guard rules-only rather than falling back to another provider.

**Privacy:** classifier input goes to whichever provider serves the model. The guard sends the command, matched rule reasons, cwd, git branch, and dirty flag. The watchdog sends the command, cwd, runtime, seconds since output changed, and an output tail. Text is redacted for common secret shapes (API keys, tokens, passwords, Bearer, AWS, JWT, private keys, URL credentials) on a best-effort basis. No conversation content or files are sent.

## Commands

```
/bash-guard [status]         show status
/bash-guard on|off           guard + watchdog for this session
/bash-guard guard on|off     guard only
/bash-guard watchdog on|off  watchdog only
pi --no-bash-guard           disable both for one run
```

Toggles persist across resume, reload, and fork. Status shows the resolved model (or how to enable one), the last classifier failure, session guard decisions, classifier token usage and cost, and recent watchdog checks.

## Footer

Dim to blend with Pi's footer; problems use the warning color.

```
⛨ BG                            healthy, no risky command judged yet
⛨ BG 4✓ 1? 1✗                   risky commands: passed by Jev, asked and allowed, blocked
⛨ BG ⏱ 3:10 progressing .92     running: elapsed, latest verdict and probability
⛨ BG ⏱ 7:05 stuck .88 kill 1/2  1 of 2 agreeing checks needed to kill
⛨ BG ⏱ 12:00 service            long-lived service, won't be killed
⛨ BG ⏱2 7:05 waiting .81        2 running, showing the oldest
⛨ BG rules-only · 2?            no Jev classifier
⛨ BG jev ✗ timeout · 4✓         last Jev call failed; clears on next success
⛨ BG guard-only · 4✓            watchdog off (watch-only when the guard is off)
⛨ BG ⚠ bash conflict · 4✓       another extension owns the bash override
⛨ BG off                        disabled
```

The tally counts only risky commands, hides zero buckets, and resets each session. While commands run, a ticking clock replaces it.

## Configuration

`~/.pi/agent/bash-guard.json`, overridden by `<cwd>/.pi/bash-guard.json`. Invalid files are reported and skipped; an invalid merged result falls back to defaults. Defaults, plus example patterns:

```json
{
  "guard": {
    "enabled": true,
    "allowBelow": 0.5,
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
    "timeoutMs": 3000,
    "model": "openrouter/~typesafe/jev-latest"
  }
}
```

`extraRiskyPatterns` and `allowPatterns` are regexes matched against the full command; allow wins over built-in rules, and invalid regexes are reported and skipped. `jev.timeoutMs` applies per call. Leave `jev.model` unset for auto-detection.

## Limits

- Only the `bash` tool is guarded; `!` user commands are not.
- The table is deliberately lenient: plain `rm file`, normal `git push`, and `terraform plan` pass.
- SQL is detected in `-c`/`-e` (psql, mysql) and positional args (sqlite3), not on stdin.
- Quoting inside `$( )` is not tracked for paren balancing, and wrappers are recognized by name, so aliased binaries are not unwrapped.
- Watchdog thresholds use the chosen status's probability, not Jev's self-reported `confidence`.
