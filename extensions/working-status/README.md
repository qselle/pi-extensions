# working-status

Adds the current phase and elapsed run time to Pi's native working indicator.

```text
Thinking · 8s
Running bash: bun, read src/index.ts ×2 · 1m 12s
Writing · 1m 18s
```

## Usage

Enable the extension through `pi config`, then reload. Waiting, thinking, writing, compaction, and tool execution update from
host events. Concurrent tools remain visible until each completes; up to two
distinct activity labels appear with an overflow count. Repeated activities show
their active call count (`×2`), and the overflow counts remaining calls. Time measures the whole run
using a monotonic clock, not the current model request.

Native read/edit/write calls show the last two path components, bounded to 32
characters and stripped of terminal controls. Bash calls show only a recognized
executable family such as `bun`, `git`, or `curl`; arguments, environment values,
URLs, and command output never enter the label. Other tools retain their short
tool name. Pi clips the working row to the terminal width, including wide Unicode
file names.

Collapsed thinking keeps Pi's default label and behavior. The extension does not
rename thinking blocks or override the native thinking toggle.

The label refreshes at most once per second while its phase stays the same. It
restores Pi's default message and releases its timer when the agent settles or
the session shuts down. No timers run while idle.

`/working-style` shows the current choice. Set one with:

| Command | Indicator |
|---|---|
| `/working-style native` | Pi's default animation |
| `/working-style pulse` | A compact dot pulse, updated by Pi every 240 ms |
| `/working-style static` | A still dot, without spinner animation |
| `/working-style text` | Phase and elapsed text only |

Choices apply immediately during a run and persist as custom entries on the
current session branch. New branches without a saved choice use the compact pulse. No
configuration file is required. Static and text modes keep the once-per-second
elapsed label; they remove indicator motion. Pi owns animation timing, and the
extension restores the native indicator when its working row is released.

## Dependencies and limitations

- Pi 0.87.0 public working-message and lifecycle APIs; no runtime packages.
- Cross-platform interactive TUI only; RPC and JSON modes are unchanged.
- Uses Pi's public indicator customization and the editor's embedded working row.
- Enable only one extension that owns the working message at a time.
- Phase labels describe received events, not unobservable provider activity.
