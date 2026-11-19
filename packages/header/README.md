# @zle13/pi-header

A responsive custom startup header extension for Pi Coding Agent featuring a distinctive olive green ASCII logo, a balanced side-by-side text layout, and expandable keybinding hints that dynamically reflect your active keybindings.

---

## Features

- **Side-by-Side Card Layout**: Places the startup title, keybinding shortcuts, expansion hints, and onboarding guidance directly to the right of the ASCII art, spanning rows 0 to 9 to form a balanced banner.
- **True Keybindings Resolution**: Queries Pi's live `KeybindingsManager` in real-time. Customized keybindings (from `~/.pi/agent/keybindings.json`) are automatically reflected (e.g. `option+p/option+n` for model cycling, `escape/ctrl+g` for interrupt, `option+e` for external editor). Unbound actions are safely omitted.
- **Pi 1.0 Expandable Help (`ctrl+o`)**:
  - **Compact Mode (Default)**: Displays single-line quick actions, the startup expansion hint, and onboarding text.
  - **Expanded Mode**: Expands into a 2-column matrix of all 19 keyboard shortcuts when `ctrl+o` (`app.tools.expand`) is pressed.
- **Narrow Terminal Fallback**: Automatically stacks the layout vertically when terminal width is below 85 columns to avoid clipping.
- **Restore Command**: Run `/builtin-header` to restore Pi's default startup header at any time during a session.

---

## Visual Preview

### Compact Mode (Default)

```text
   ███████████████████████████╗     pi v1.0.0
   ╚══██████╔════════██████╔══╝   
      ██████║        ██████║     escape/ctrl+g interrupt · ctrl+c/ctrl+d clear/exit
      ██████║        ██████║     / commands · ! bash · ctrl+o more
      ██████║        ██████║   
      ██████║        ██████║     Press ctrl+o to show full startup help.
      ██████║        ██████║   
      ██████║        ██████║   
   ████████████╗  ████████████╗     Pi can explain its own features and look up its docs.
   ╚═══════════╝  ╚═══════════╝     Ask it how to use or extend Pi.
```

### Expanded Mode (`ctrl+o`)

```text
   ███████████████████████████╗     pi v1.0.0
   ╚══██████╔════════██████╔══╝   escape/ctrl+g to interrupt            ctrl+t to expand thinking
      ██████║        ██████║      ctrl+c to clear                       option+e for external editor
      ██████║        ██████║      ctrl+c twice to exit                  / for commands
      ██████║        ██████║      ctrl+d to exit (empty)                ! to run bash
      ██████║        ██████║      ctrl+z to suspend                     !! to run bash (no context)
      ██████║        ██████║      ctrl+k to delete to end               option+enter to queue follow-up
      ██████║        ██████║      shift+tab to cycle thinking level     option+up to edit all queued messages
   ████████████╗  ████████████╗   option+p/option+n to cycle models     option+i to paste files on macOS, images, or text
   ╚═══════════╝  ╚═══════════╝   ctrl+l to select model                drop files to attach
                                  ctrl+o to expand tools

                                  Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.
```

---

## Installation

This extension is source-only. From the root of a local checkout:

```bash
pi install -l ./packages/header
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/zle-pi/packages/header"
  ]
}
```

Then reload Pi with `/reload`.

---

## Commands

- `/builtin-header`: Restores Pi's built-in header for the current session.

---

## License

[MIT](./LICENSE) © zle13
