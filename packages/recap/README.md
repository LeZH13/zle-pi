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

After three user prompts, a short recap appears **above the input editor**:

```text
※ recap: OAuth callback validation fixed; tests pass, review pending
```

Automatic recap generation runs after the agent has fully settled, with no pending automatic retry or continuation, and only for completed responses. It refreshes every three completed agent runs by default. Unchanged input skips generation; substantially similar automatic results keep the displayed text stable.

`/recap` regenerates immediately, bypassing the prompt threshold, cooldown, and similarity suppression. Successful recaps survive reloads, resume, and forks, following the active branch. Cooldown counters are persisted with the recap state. Automatic failed attempts observe the cooldown too; a manual refresh can retry sooner.

The recap is a UI widget and non-context session metadata. It is **not compaction** and does not inject itself into future model context.

### Names: stable session identity

An initially empty new session receives a short descriptive title after its first fully completed response, including tool work:

```text
OAuth callback validation
```

- Titles aim for 4–8 words, match the conversation language, and are capped at 60 Unicode code points, including an ellipsis when shortened.
- Automatic naming applies only if the session remains unnamed. Existing names from `/name`, `--name`, or another extension are preserved.
- Once named, the title stays unchanged across later responses.
- If generation fails, automatic naming retries after a later completed response while that new session remains eligible and unnamed.
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
    "maxWords": 40,
    "minTurns": 3,
    "cooldownTurns": 3,
    "similarityThreshold": 0.7,
    "placement": "above",
    "autoName": true
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | Active session model | Shared model for recap and naming. Prefer a full `provider/model-id`; a bare ID resolves against the current session model's provider. |
| `maxWords` | `40` | Maximum whitespace-separated words in a recap |
| `minTurns` | `3` | User messages required before the first automatic recap |
| `cooldownTurns` | `3` | Completed agent runs between automatic recap attempts; does not delay the first eligible recap |
| `similarityThreshold` | `0.7` | Word-set Jaccard overlap at or above which an automatic result retains the displayed recap; between 0 and 1 |
| `placement` | `"above"` | `"above"` or `"below"` the editor; above leaves the custom footer area alone |
| `autoName` | `true` | Enable initial automatic naming; `/autoname` remains available when false |
| `prompts.recap` | Built-in | Replace the recap system prompt |
| `prompts.name` | Built-in | Replace the naming system prompt |

Word and turn limits must be positive safe integers. Invalid values use their defaults. Title length stays fixed at 60 code points. Prompt overrides should request one plain-text content line; validation and length caps still apply.

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
- Requests are cancelled on a new agent run, session replacement, tree navigation, reload, or shutdown. Session/run identity and conversation snapshot checks prevent stale writes even if a provider ignores cancellation.
- Summary inputs use the original goal, up to three recent conversation rounds, and a bounded current context summary. Context edits, compaction, and the active branch are respected; abandoned raw paths, thinking blocks, images, and tool-result bodies are not sent.
- Failed, aborted, length-capped, empty, multiline, malformed JSON-like, or excessively long responses do not replace the previous successful result. Automatic errors are deduplicated by feature and error within the session; explicit commands report failures each time.

## Privacy and cost

Recap and naming generation make **additional model requests**, sending bounded conversation excerpts to the active or explicitly configured provider. A cheaper dedicated model can reduce cost. Automatic title generation normally adds one successful call per new session; automatic recaps follow the configured cadence. Side-call usage is not included in Pi's main-session usage totals by this extension.

There are no naming/recap calls from excluded modes or subagent processes. To avoid all side-calls, do not load the package; `autoName: false` disables only automatic naming, not automatic recaps.

## Development

Use this package's npm scripts and the repository's root checks. Tests include real SessionManager projections, deferred-response race regressions, terminal-width rendering, and a Pi SDK integration test with a mock provider and temporary isolated settings. No real provider requests are made by the test suite.

## License and attribution

Apache-2.0. Adapted from **pi-recap by L2ncE**, inspired by Claude Code's recap interface. See [LICENSE](LICENSE), [NOTICE](NOTICE), and the modification notices in the adapted source files.
