# @zle13/pi-prompt-snippets

Mix-and-match single-purpose prompt rules that are prepended or appended to your message when you send it in Pi.

Unlike full skills, each snippet is a lightweight, standalone instruction — toggle exactly the ones you want for your next message.

> **Credits:** Originally created by [Amos Blomqvist](https://github.com/amosblomqvist) in [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config).

---

## Installation

```bash
pi install npm:@zle13/pi-prompt-snippets
```

Or install locally from source:

```bash
pi install -l ./packages/prompt-snippets
```

Then restart Pi or run `/reload` in your active session.

---

## Usage

- Press **Alt+S** or run **/snippets** to open the interactive toggle menu.
  - `↑` / `↓` to navigate items.
  - `Space` to toggle snippet active / inactive.
  - `Tab` to preview the highlighted snippet (shows name, placement, order, source origin, filename, and prompt body). Press `Tab` or `Esc` to return to the list with cursor position preserved.
  - `Enter` to apply your selection.
  - `Esc` to cancel and discard changes.
- **Active Snippet Indicator:** Active snippets appear as a widget above the editor:
  - `↑ prepend: ...` (accent color) — inserted before your message.
  - `↓ append: ...` (warning color) — inserted after your message.
- When you send a message, active snippets are merged in order:
  `[Prepend group (sorted by order)] → [Your message] → [Append group (sorted by order)]`, separated by blank lines.
- **Automatic Reset:** Active toggles reset to all off after every send and at session start.

---

## Multi-Directory Hierarchy

Snippets are discovered dynamically across three layers (in increasing precedence):

1. **Bundled package snippets:** Default rules shipped with this extension.
2. **Global user snippets:** `~/.pi/agent/snippets/*.md`
3. **Project snippets:** `.pi/snippets/*.md` (in your workspace, honored when the project is trusted).

Files are re-scanned whenever the menu opens or a message is sent, so edits take effect immediately without restarting Pi.

---

## Customizing, Overriding & Disabling Snippets

### 1. Add Your Own Snippets

Create any `.md` file in `~/.pi/agent/snippets/` (for all projects) or `.pi/snippets/` (for the current project):

```markdown
---
name: Concise Output
description: Short, direct answers without unnecessary fluff
placement: prepend
order: 10
---
Keep your response concise. Skip preamble and unnecessary explanation.
```

### 2. Override Existing Snippets

Create a file with the same filename (e.g. `.pi/snippets/ask-questions.md` or `~/.pi/agent/snippets/ask-questions.md`). Higher-precedence layers completely override lower-precedence ones.

### 3. Disable Default Snippets

You can disable default or global snippets in two ways:

#### Option A: Frontmatter `disabled: true`
Create a file with the same filename in `~/.pi/agent/snippets/` or `.pi/snippets/` and set `disabled: true`:

```markdown
---
disabled: true
---
```

#### Option B: Configuration File
Create `.pi/prompt-snippets.json` (project-level) or `~/.pi/agent/prompt-snippets.json` (global):

```json
{
  "disabled": [
    "ask-questions",
    "diagnose-report.md"
  ]
}
```

---

## Snippet Frontmatter Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | Filename without `.md` | Display name shown in the menu |
| `description` | `string` | `""` | Description subtitle shown in the menu |
| `placement` | `"prepend"` \| `"append"` | `"append"` | Whether the rule is placed before or after your prompt |
| `order` | `number` | `9999` | Sort order within its placement group (lower numbers first) |
| `disabled` | `boolean` | `false` | When `true`, disables/hides this snippet ID from the list |

---

## License

MIT © zle13. Original work © Amos Blomqvist.
