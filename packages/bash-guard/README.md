# @zle13/pi-bash-guard

A guard and a watchdog for Pi's `bash` tool, sharing one **Jev** client (TypeSafe System One, a decision-only model). The guard judges risky commands before they run; the watchdog watches long-running commands and kills or steers them when they stop making progress.

```sh
pi install npm:@zle13/pi-bash-guard
```

Or try it once:

```sh
pi -e npm:@zle13/pi-bash-guard
```

## How it works

**Guard (pre-execution, bash tool only).** Every `bash` tool call is tokenized (shell-quote; compound separators, `$(...)`, backticks — including inside double quotes, `bash -c`/`sh -c`/`eval` payloads with option clusters like `-lc`) and matched against a curated built-in risky-pattern table: `rm` with `-r`/`-f`/unquoted globs, `git reset --hard`, force pushes and `:branch` deletes, `git clean -f` (dry runs like `-n`/`--dry-run` pass), `git checkout --`/`git restore`, `git branch -D`, `git stash drop/clear`, `dd`, `mkfs*`, `shred`, `wipefs`, `truncate`, `find -delete`/`-exec rm`, destructive SQL through `psql`/`mysql`/`sqlite3`, `terraform destroy`/`apply -auto-approve`, `kubectl delete`, `docker rm/rmi/volume rm/system prune`, `chmod -R`/`chown -R`, `npm unpublish`, `gh repo delete`, `aws s3 rm --recursive`/`s3 rb`.

Matching happens on the command that actually runs: leading env assignments (`X=1 rm -rf`), wrappers (`sudo`, `doas`, `env`, `command`, `exec`, `nohup`, `time`, `nice`, `xargs`, `timeout`), git global options (`-C`, `-c`, `--git-dir`, `--work-tree`), shell control keywords (`if/then/else/fi`, `while/do/done`, `for`, `!`, `{ }`), and subshell groups are normalized away. Quoted text (`echo "rm -rf /"`, `rm 'literal*file'`) is data, not a command, and never matches.

- Non-risky commands run instantly; no classifier call is made.
- Risky commands ask Jev exactly one question: could running this command cause **irreversible loss** (data, history, remote state) that cannot be undone with normal tooling? The state sent to the classifier is only the command, the matched rule reasons, the cwd, and cheap git facts (branch, dirty) — all redacted for common secret shapes (tokens, keys, passwords, Bearer, AWS, URL credentials). Nothing else from the session.
- Probability below `allowBelow` (default 0.5) → allowed. Anything else — irreversible, uncertain, Jev error, timeout, malformed answer — escalates: with a UI you get *Allow once / Allow for this session / Block* (the dialog is cancelled if the tool call is aborted, which blocks); without a UI the command is blocked. "Allow for this session" remembers the exact command string for the session (also persisted on the session branch).
- Without any Jev classifier (check `/bash-guard status`) the table runs **rules-only**: risky commands still escalate, and you get a one-time notice naming how to enable Jev (for example `/login openrouter` or setting `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`).

`allowBelow` calibration from live Jev scores: routine cleanups (`rm -rf build`/`node_modules`/`dist`, `find -delete`, `docker system prune`) score ≈0.2–0.48 and pass at 0.5; clearly destructive commands (`rm -rf ~`/`/` ≈0.95, `DROP DATABASE` ≈0.84, `rm -rf .git` ≈0.72, `push --force main` ≈0.61, `reset --hard HEAD~5` ≈0.52) escalate. `git clean -fd` (≈0.57) asks; `git branch -D` (≈0.35) passes as reflog-recoverable. Lower `allowBelow` for stricter behavior.

**Jev score line.** Every bash call the guard judged and then allowed — including the silent below-threshold passes and dialog approvals — renders a dim `⛨ bash-guard: jev p=0.31 recoverable` line under the command in the transcript (`⛨ bash-guard: jev p=0.60 allowed by user` after a dialog approval; the ⛨ badge matches the footer status identity). Blocked commands show the same score inside their block reason, so no extra line is rendered there. Scores live for the running session only; resumed sessions do not re-render lines for older calls.
- Allow patterns (user config) win over built-in risky rules.

**Watchdog (running commands).** The watchdog overrides the `bash` tool with pi's own local shell operations wrapped in a tracking layer. Each running command gets a bounded output tail (redacted before anything is sent anywhere) and periodic Jev checks — first at `firstCheckSec` (default 120), then every `intervalSec` (default 300) — asking:

- `status`: `progressing` / `waiting` / `stuck` / `looping`
- `persistent`: is this a legitimate long-lived service (dev server, watcher, log tail) operating normally?

When the chosen status is `stuck` or `looping` with probability ≥ `confidence` (default 0.8) for `agreeChecks` (default 2) consecutive checks, the command is killed: its process tree is aborted, the tool result states that the watchdog killed it and why, and the agent is steered to try a different approach instead of rerunning the same command. A `persistent` service (≥ 0.5) is never killed unless the status is `looping`; instead the agent is steered once per command to background it (e.g. `nohup ... > /tmp/name.log 2>&1 &`). Jev unavailable → the watchdog does nothing (shown in status).

Every check is recorded in a bounded log (last 10 per command): elapsed seconds, status with all choice probabilities, persistent p, and the outcome (`agree n/N`, `veto`, `kill`, or `failed: <reason>`). The log rides in the bash tool result's `details` (`bashGuardWatchdog.checks`) for the UI, and `/bash-guard status` shows the latest checks for running and recently finished commands. It is never added to model-facing content (except the existing kill reason).

If another extension already overrides `bash`, the watchdog cannot watch commands; you get a warning at session start and the guard keeps running.

## Jev classifiers

Jev (TypeSafe System One) is reached through Pi's built-in classifier API, so the credentials you already configured for Pi work — no extra SDK or account:

| Provider | Model IDs | Authentication |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `~typesafe/jev-latest`, `typesafe/jev-1.13` | `OPENROUTER_API_KEY` or `/login openrouter` |
| `opencode` | `jev-1.13` | `OPENCODE_API_KEY` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `cloudflare-workers-ai` | `typesafe/jev` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |

With no `jev.model` configured, the first available Jev classifier in that order is used (auto-detected at session start and re-resolved lazily, so `/login` takes effect without a restart). To pin one, set `jev.model` to `"provider/modelId"`:

```json
{ "jev": { "model": "openrouter/~typesafe/jev-latest", "timeoutMs": 3000 } }
```

A configured model that is unavailable is reported and the guard stays rules-only — it never silently falls back to another provider. Per attempt the timeout is `jev.timeoutMs` (default 3000 ms). Classifier usage is shown in `/bash-guard status` as session totals; the cost is the model's catalog price (TypeSafe's direct `jev-latest` reports tokens at no cost).

**Privacy:** the classified state goes to whichever provider serves the model. What leaves the machine: guard — redacted command, matched rule reasons, redacted cwd/branch, dirty flag; watchdog — redacted command/cwd, runtime, seconds since last output change, and a redacted output tail (tokens, keys, passwords, Bearer/AWS/JWT/URL-credential shapes). No conversation content, no files.

## Command, flag, status

```
/bash-guard                  show status
/bash-guard on|off           enable/disable guard + watchdog for this session
/bash-guard status
/bash-guard guard on|off     toggle the guard only
/bash-guard watchdog on|off  toggle the watchdog only
```

Toggles are session-scoped and persist across resume/reload/fork via session entries. `/bash-guard status` shows the resolved provider/model, the enable hint when off, the last classifier failure, session guard decisions, and session classifier usage. `pi --no-bash-guard` disables both for one run.

### Footer status

The footer line is dim so it blends with pi's footer. Problems use the warning color.

```
⛨ BG                          healthy, no risky command judged yet
⛨ BG 4✓ 1? 1✗                 risky commands this session: passed by Jev, asked and allowed, blocked
⛨ BG ⏱ 3:10 progressing .92   a watched command is running: elapsed time, latest Jev verdict and probability
⛨ BG ⏱ 7:05 stuck .88 kill 1/2  1 of 2 consecutive confident stuck/looping checks needed to kill (agreeChecks)
⛨ BG ⏱ 12:00 service          judged a long-lived service, so it won't be killed
⛨ BG ⏱2 7:05 waiting .81      2 commands running, showing the oldest
⛨ BG rules-only · 2?          no Jev classifier; the watchdog is inert
⛨ BG jev ✗ timeout · 4✓       the last Jev call failed; clears on the next success
⛨ BG guard-only · 4✓          watchdog toggled off (watch-only when the guard is off)
⛨ BG ⚠ bash conflict · 4✓     another extension owns the bash override
⛨ BG off                      both off, or --no-bash-guard
```

The tally counts only commands that matched a risky rule. Zero buckets are hidden, and the counts reset with each session. While commands run, the clock ticks every second and replaces the tally.

## Configuration

`~/.pi/agent/bash-guard.json` (user) merged with `<cwd>/.pi/bash-guard.json` (project overrides). Invalid files are reported and skipped; the merged result is validated with TypeBox and falls back to defaults when invalid.

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

`extraRiskyPatterns` and `allowPatterns` are regex strings matched against the full command string (allow wins over built-in risky rules). A pattern that compiles to a false positive is visible in status; invalid regexes are reported and skipped. `jev.model` must be `"provider/modelId"`; leave it unset for auto-detection.

## Behavior notes and limits

- The pattern table is deliberately lenient: plain `rm file`, normal `git push`, and `terraform plan` pass without escalation. Quoted text (`echo "rm -rf /"`, `rm 'literal*file'`) is not a command and never matches; `bash -c 'rm -rf x'` and `sudo rm -rf x` do.
- The guard only looks at the `bash` tool (`!`-prefixed user commands are your own responsibility). It is irreversibility-only and must not be strict: anything below `allowBelow` passes, and the escalation dialog is the second opinion.
- Watchdog kills abort the command's own controller; pi's bash tool then terminates the process tree. The resulting tool result says it was killed by the watchdog, with the reason and a redacted output tail. An unavailable/malformed Jev check resets the kill-agreement counter, so a kill always needs consecutive agreeing checks on both sides of the outage.
- Watchdog status probability is read from the chosen label's probability (Jev also reports a separate self-assessed `confidence`, which is not used for thresholds).
- SQL detection covers `-c`/`-e` (psql, mysql) and positional SQL (sqlite3); SQL piped on stdin is not visible to the matcher.
- Known matcher limits: quoting inside `$( )` bodies is not tracked for paren balancing; SQL `DELETE ... WHERE` detection spans the whole joined args; wrappers are unwrapped by name, so aliased or renamed binaries are not normalized.
