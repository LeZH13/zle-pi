# @zle13/pi-recap

Session recaps and automatic session naming for [Pi](https://pi.dev). Adapted from [L2ncE/pi-recap](https://github.com/L2ncE/pi-recap).

Requires **Pi 1.0.2 or newer**. Runs only in the interactive terminal (TUI).

## Try locally

From the repository root:

```bash
pi -e ./packages/recap
```

This loads the package for that invocation without changing your package settings. Restart the invocation after code changes.

To keep a local installation:

```bash
pi install ./packages/recap
```

After a public release, the npm installation command will be:

```bash
pi install npm:@zle13/pi-recap
```

**Replace `@lanlance/pi-recap`, rather than loading both.** They both register `/recap`; running both would duplicate generation and conflict on the command. Remove the original package if installed:

```bash
pi remove npm:@lanlance/pi-recap
```

Then restart Pi or reload extensions. Previous upstream recap metadata is not migrated.

## Behavior

### Recaps: current progress

After at least three user prompts and **two uninterrupted minutes of idle time** following a successfully completed agent run, a short recap appears **above the input editor**:

```text
※ recap: OAuth callback validation fixed and tests pass. Next, get review sign-off before merging.
```

The recap is one short sentence on the goal and current state, followed by a brief next-step tip — or one open question when no clear next step follows from the conversation.

The three-prompt minimum is a session threshold, not a recurring cooldown. Once reached, every successful settled run with changed conversation input can arm a new idle countdown.

Automatic generation is armed only after a successful, fully settled response: no pending tools, automatic retries, or continuations. Tools awaiting your answer or a bash-guard approval are still busy and do not count as idle. An assistant's final text asking a question does count as settled.

Typing, pasting, and other terminal interaction reset the countdown without consuming your input; terminal capability replies and focus reports do not. Activity during recap generation cancels that request and starts a new idle countdown when the conversation remains eligible.

New work hides the previous recap immediately. A recap is shown only while idle and when its conversation fingerprint matches the active branch. Restored recaps are checked the same way on reload, resume, and tree navigation. New activity cancels pending generation; late results cannot overwrite current state. A small animated **Generating recap…** badge appears only while a recap request is running, not during the idle countdown. The badge is the sole generation indicator, including for `/recap`; no duplicate start notification is shown. Fresh results always use the newly generated wording.

`/recap` regenerates immediately while idle, bypassing the prompt threshold and idle delay. A failed automatic request is not repeatedly retried during the same idle period; another successful run can schedule a new attempt, or `/recap` can retry immediately.

The recap is a UI widget and non-context session metadata. It is **not compaction** and does not inject itself into future model context.

### Names: stable session identity

An initially empty new session receives a short descriptive title after its first fully completed response, including tool work:

```text
OAuth callback validation
```

- Titles are compact identifying labels of the session's subject and topic — ideally 3–6 words — and match the conversation language. They never describe the assistant's workflow, progress, next steps, or incidental qualifiers about how the work is done.
- Titles are capped at 60 Unicode code points and 6 words (the word cap only applies to space-separated writing; whitespace-free scripts are governed by the code-point cap). An overlong title triggers one corrective regeneration with the same model and subject context; if the retry is still invalid, no title is applied. Titles are never silently sliced or abbreviated with an ellipsis.
- Automatic naming applies only if the session remains unnamed. Existing names from `/name`, `--name`, or another extension are preserved.
- Once named, the title stays unchanged across later responses.
- If generation fails, automatic naming retries after a later completed response while that new session remains eligible and unnamed.
- Naming input is subject-focused: the session's original goal, the user's own messages, and the tools the session touched. Assistant narration, tool outcome excerpts, and recap state framing are never sent to the naming model.
- Reloading an eligible session retains pending naming eligibility. Resuming it revokes eligibility; a subsequent reload does not re-enable it.
- Resumed conversations, forks, clones, and sessions with parent-session linkage are not automatically named. Use `/autoname` in those sessions.

Names use Pi's native session metadata and appear in the session picker and any extension displaying the session name, including `@zle13/pi-editor`.

## Commands

| Command | Action |
| --- | --- |
| `/recap` | Generate and display a new recap now |
| `/autoname` | Generate and immediately apply a replacement session title, even if a title already exists or automatic naming is disabled |
| `/name <text>` | Pi's unchanged built-in command for an exact manual title |

`/recap` and `/autoname` take no arguments. They decline with a notice while the main agent or another recap/title request is working; they do not queue requests. A manual rename made during title generation wins over the older generated result.

## Configuration

Add a `recap` object to `~/.pi/agent/settings.json` (or the corresponding settings file when using a custom Pi agent directory). Trusted project settings in `.pi/settings.json` can override it. The extension reads Pi's effective settings API, not project files independently.

All settings are optional:

```json
{
  "recap": {
    "model": "provider/model-id",
    "maxWords": 50,
    "minTurns": 3,
    "idleDelaySeconds": 120,
    "placement": "above",
    "autoName": true
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | Active session model | Shared model for recap and naming. Prefer a full `provider/model-id`; a bare ID resolves against the current session model's provider. |
| `maxWords` | `50` | Maximum whitespace-separated words in a recap; longer model output is trimmed to this many words with an appended … |
| `minTurns` | `3` | User messages required before the first automatic recap |
| `idleDelaySeconds` | `120` | Uninterrupted idle seconds after a successful settled run before automatic generation |
| `placement` | `"above"` | `"above"` or `"below"` the editor; above leaves the custom footer area alone |
| `autoName` | `true` | Enable initial automatic naming; `/autoname` remains available when false |
| `prompts.recap` | Built-in | Replace the recap system prompt |
| `prompts.name` | Built-in | Replace the naming system prompt |

Word, prompt-count, and idle-delay limits must be positive safe integers. `cooldownTurns` and `similarityThreshold` have been removed; replace turn-based cadence with `idleDelaySeconds`. Idle delays must not exceed 2,147,483 seconds (Node's timer limit). Invalid values use their defaults. Title limits stay fixed at 60 code points and 6 words and are enforced regardless of prompt overrides: an overlong title triggers one corrective request, and a still-invalid title is never applied. Prompt overrides should request one plain-text content line; validation still applies. Recaps keep the model's trailing punctuation (`.`, `?`, `!`), so a recap may end with an open question; session titles strip trailing periods.

For example, disable automatic naming and use a custom naming prompt for explicit `/autoname` calls:

```json
{
  "recap": {
    "autoName": false,
    "prompts": {
      "name": "Output only a short English subject/action phrase naming this session. No progress report, markdown, or explanation."
    }
  }
}
```

If `model` is unset or blank, both features use the active session model without changing its model or thinking level. If an explicitly configured model is unavailable or unauthenticated, generation fails with a notice: **there is no fallback to another model/provider**.

## Runtime exclusions and safety

- Print, JSON, and RPC modes perform no generation, naming, widget updates, or metadata writes.
- When `PI_SUBAGENT_ID` or `PI_SUBAGENT_SESSION` is nonblank, the extension registers nothing. This leaves `pi-interactive-subagents` child session names alone, including interactive children and resumed children.
- Only one recap/title side-call runs at a time. Initial naming and recap generation have separate schedules and prompts, but share their model and bounded context extraction.
- Requests are cancelled on new submitted input, a user shell command, a new agent run, session replacement, tree navigation, reload, or shutdown; recap requests also cancel on terminal activity. Session/run identity and conversation snapshot checks prevent stale writes even if a provider ignores cancellation.
- Summary inputs prioritize the latest exchange, with smaller excerpts from earlier rounds, the original goal, and current context summary. Long excerpts retain their beginning and ending with an explicit omission marker. Bounded tool outcome/error excerpts help distinguish attempted work from verified success. Context edits, compaction, and the active branch are respected; abandoned raw paths, thinking blocks, and images are not sent. Conversation freshness is checked independently of these shortened excerpts.
- Failed, aborted, length-capped, empty, multiline, malformed JSON-like, or excessively long responses do not replace the previous successful result. Automatic errors are deduplicated by feature and error within the session; explicit commands report failures each time.

## Privacy and cost

Recap and naming generation make **additional model requests**, sending bounded conversation excerpts to the active or explicitly configured provider. A cheaper dedicated model can reduce cost. Automatic title generation normally adds one successful call per new session; automatic recaps follow the configured idle delay. Side-call usage is not included in Pi's main-session usage totals by this extension.

There are no naming/recap calls from excluded modes or subagent processes. To avoid all side-calls, do not load the package; `autoName: false` disables only automatic naming, not automatic recaps.

## Development

Use this package's npm scripts and the repository's root checks. Tests include real SessionManager projections, deferred-response race regressions, terminal-width rendering, and a Pi SDK integration test with a mock provider and temporary isolated settings. No real provider requests are made by the test suite.

## License and attribution

Apache-2.0. Adapted from **pi-recap by L2ncE**, inspired by Claude Code's recap interface. See [LICENSE](LICENSE), [NOTICE](NOTICE), and the modification notices in the adapted source files.
