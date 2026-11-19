# @zle13/pi-prompt-snippets

Mix-and-match prompt rules that prepend or append to your next message in [Pi Coding Agent](https://pi.dev) and reset automatically after sending.

> **Credits:** Originally created by [Amos Blomqvist](https://github.com/amosblomqvist) in [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config).

## Installation

```bash
pi install npm:@zle13/pi-prompt-snippets
pi -e npm:@zle13/pi-prompt-snippets   # try for one session
```

Then restart Pi or run `/reload`.

## Usage

Press **`Alt+S`** or run **`/snippets`** to open the toggle menu:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Navigate snippets (respects `tui.select.*` bindings from `keybindings.json`) |
| `Space` | Toggle snippet on / off |
| `Tab` | Preview highlighted snippet metadata and prompt body (`Tab` or `Esc` returns) |
| `Ctrl+E` | Manage snippets (create, edit, duplicate, delete, hide, or restore) |
| `Enter` | Apply selection |
| `Esc` | Discard toggle changes (saved snippet edits remain saved) |

- **Live indicator:** active snippets appear above the editor as `↑ prepend: ...` and `↓ append: ...`.
- **Merge order:** `[Prepend group (by order)] → [Your message] → [Append group (by order)]`, separated by blank lines.
- **Auto-reset:** active toggles clear after every send and at session start.

## Managing & customizing snippets

Snippets are discovered dynamically across three layers (increasing precedence) and re-scanned on every menu open and send:

1. **Bundled:** default snippets shipped with this package
2. **Global:** `~/.pi/agent/snippets/*.md`
3. **Project:** `.pi/snippets/*.md` (trusted projects only)

### Edit inside Pi (`Alt+S` → `Ctrl+E`)

Create, edit, duplicate, or delete user snippets without leaving Pi:

- Editing a bundled snippet creates an override in your chosen Global or Project directory without modifying package files.
- Bundled snippets can be hidden globally or per project, and revealed again via **Restore hidden snippet**.
- External file edits are never overwritten silently; symlinked files/directories are read-only.

### Edit files directly

Add a `.md` file to `~/.pi/agent/snippets/` or `.pi/snippets/` (using an existing filename overrides lower-precedence layers):

```markdown
---
name: Concise Output
description: Short, direct answers without unnecessary fluff
placement: prepend
order: 10
---
Keep your response concise. Skip preamble and unnecessary explanation.
```

| Frontmatter | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | Filename without `.md` | Display name in the menu |
| `description` | `string` | `""` | Subtitle in the menu |
| `placement` | `"prepend"` \| `"append"` | `"append"` | Place before or after your prompt |
| `order` | `number` | `9999` | Sort order within its placement group (lower first) |
| `disabled` | `boolean` | `false` | Hide/disable this snippet ID from the list |

You can also disable snippets via `~/.pi/agent/prompt-snippets.json` or `.pi/prompt-snippets.json`:

```json
{
  "disabled": ["ask-questions", "diagnose-report.md"]
}
```

## Auditing prompt & snippet usage

Run **`/snippets-audit`** (e.g. `/snippets-audit this project, last 60 days`) to have the agent review recent main-session prompts against your effective snippets and suggest additions or cleanup. It is read-only and never edits sessions or snippet files.

- When active snippets transform a prompt, their filename IDs and sources are recorded as non-context session metadata (never prompt or snippet bodies) so audits can count usage.
- To run the bundled read-only exporter yourself:

```bash
python3 audit/prompts.py --since-days 30 --cwd my-project
python3 audit/prompts.py --since-days 30 --cwd my-project --format jsonl
```

## License

MIT applies to original contributions by zle13. The upstream material is by Amos Blomqvist; its license has not been verified. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
