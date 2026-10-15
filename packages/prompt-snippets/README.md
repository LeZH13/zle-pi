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
  - `↑` / `↓` (or custom selection keybindings like `Ctrl+P` / `Ctrl+N`) to navigate items.
  - `Space` to toggle snippet active / inactive.
  - `Tab` to preview the highlighted snippet (shows name, placement, order, source origin, filename, and prompt body). Press `Tab` or `Esc` (or `Ctrl+G` / `Ctrl+C`) to return to the list with cursor position preserved.
  - `Ctrl+E` to manage snippets: create, edit, duplicate, delete your files, hide bundled snippets, or restore hiding files. Sources (`bundled`, `global`, `project`) appear beside each snippet.
  - `Enter` to apply your selection.
  - `Esc` to cancel and discard **toggle changes only**. Explicitly saved snippet edits remain saved.
- **Keybinding Integration:** Respects custom `tui.select.*` actions from `~/.pi/agent/keybindings.json` (such as `tui.select.up`, `tui.select.down`, `tui.select.pageUp`, `tui.select.pageDown`, `tui.select.confirm`, and `tui.select.cancel`).
- **Active Snippet Indicator:** Active snippets appear as a widget above the editor:
  - `↑ prepend: ...` (accent color) — inserted before your message.
  - `↓ append: ...` (warning color) — inserted after your message.
- When you send a message, active snippets are merged in order:
  `[Prepend group (sorted by order)] → [Your message] → [Append group (sorted by order)]`, separated by blank lines.
- **Automatic Reset:** Active toggles reset to all off after every send and at session start.

---

## Audit past prompts and snippet usage

Run `/snippets-audit` (optionally `/snippets-audit this project, last 60 days`) to ask the agent to review recent prompts against your effective snippets and recommend additions or consolidation. This is an extension command, **not a globally discoverable skill**. The command injects the bundled audit instructions into one agent turn; it does not edit your sessions or snippets.

The bundled read-only Python 3 exporter scans local main-session JSONL files (not subagent transcripts). It defaults to 30 days, at most 30 recent sessions, and at most 60 qualifying prompts. Its report gives exact whitespace/case-normalized repeated prompt frequencies across sampled sessions, plus tracked snippet applications. The agent additionally reviews semantic variants and compares with bundled, global, and project snippets. To inspect the report yourself:

```bash
python3 audit/prompts.py --since-days 30 --cwd my-project
python3 audit/prompts.py --since-days 30 --cwd my-project --format jsonl
```

From this version onward, when active snippets transform an input, the extension records their filename IDs and resolved sources as non-context session metadata—**not prompt or snippet bodies**. Each application counts once per snippet per transformed input. The audit can count these records across sessions; past uses before tracking was installed remain unknown. Samples and branched session histories can affect frequencies. A zero count is a reason to review a snippet, not proof it is unnecessary. Treat exported prompts as private and approve any snippet changes explicitly.

---

## Multi-Directory Hierarchy

Snippets are discovered dynamically across three layers (in increasing precedence):

1. **Bundled package snippets:** Default rules shipped with this extension.
2. **Global user snippets:** `~/.pi/agent/snippets/*.md`
3. **Project snippets:** `.pi/snippets/*.md` (in your workspace, honored when the project is trusted).

Files are re-scanned whenever the menu opens or a message is sent, so edits take effect immediately without restarting Pi.

---

## Customizing, Overriding & Disabling Snippets

### Manage without leaving Pi

Press **Alt+S → Ctrl+E**. Management acts on the highlighted snippet; **New snippet** and **Restore hidden snippet** are available even when the list is empty.

- **New / Duplicate:** choose Global or This project (trusted projects only). The last chosen location is remembered for this extension runtime. Set a unique `.md` filename; existing files are never silently overwritten.
- **Edit:** opens a details screen. Select name, description, placement, order, or prompt body to edit that field. Each field shows its heading followed by a separate, dimmed **Tip:** line explaining what to enter (including placement and prompt body). **Order** is a whole number: lower values appear first within the prepend or append group (10 before 20; ties sort by name), not a model instruction priority. Existing text fields are prefilled; new snippets start with an empty, required name. The body uses Pi's multiline editor. Returning from a field only updates the draft; choose **Save snippet** to write it, or **Discard changes** to leave the file untouched.
- **Bundled edits:** choose a location for an override with the same filename. Bundled files are never modified.
- **Delete:** confirms the exact user-file path and warns about lower-priority versions becoming visible. Deleting an override is not the same as hiding its bundled/global version.
- **Hide:** bundled snippets can be hidden globally or for this project. **Restore hidden snippet** removes a confirmed bodyless hiding file to reveal the lower-priority version. Snippets disabled in `prompt-snippets.json`, or disabled files containing a prompt body, remain managed manually.

Saving or deleting returns to the toggle list with pending selections and cursor position preserved where possible. Changes take effect immediately, even if you later cancel the toggle menu. Files changed externally while a draft is open are not overwritten; discard and reopen the draft to refresh. Symlinked snippet files/directories are read-only to management; edit those manually.

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
