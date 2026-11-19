# @zle13/pi-header

A responsive custom startup header for [Pi Coding Agent](https://pi.dev) pairing an olive-green ASCII logo with live keybinding hints resolved from your active `KeybindingsManager`, expandable via `ctrl+o`.

## Visual preview

### Compact *(default)*

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

### Expanded (`ctrl+o`)

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

## Features

- **Live keybindings:** reads Pi's active `KeybindingsManager` (including customizations in `~/.pi/agent/keybindings.json`) and omits unbound actions automatically.
- **Expandable help (`ctrl+o`):** starts compact and toggles a 2-column reference of all 19 shortcuts when `ctrl+o` (`app.tools.expand`) is pressed.
- **Responsive layout:** displays side-by-side on wide terminals and stacks vertically below 85 columns to prevent clipping.

## Installation

Source-only (not yet published to npm). From a local checkout of `zle-pi`:

```bash
pi install ./packages/header   # personal (~/.pi/agent/settings.json)
pi -e ./packages/header        # try for one session
```

Restart Pi to see the updated startup header.

## Commands

| Command | Description |
| --- | --- |
| `/builtin-header` | Restore Pi's built-in startup header for the current session |

## License

MIT — see [LICENSE](./LICENSE).
