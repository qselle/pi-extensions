# working-status

Adds the current phase and elapsed run time to Pi's native working indicator.

```text
Thinking · 8s
Running bash, read · 1m 12s
Writing · 1m 18s
```

## Usage

Enable the extension through `pi config`, then reload. Waiting, thinking, writing, compaction, and tool execution update from
host events. Concurrent tools remain visible until each completes; up to two
distinct tool names appear with an overflow count. Time measures the whole run
using a monotonic clock, not the current model request.

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
current session branch. New branches without a saved choice use native. No
configuration file is required. Static and text modes keep the once-per-second
elapsed label; they remove indicator motion. Pi owns animation timing, and the
extension restores the native indicator when its working row is released.

## Dependencies and limitations

- Pi 0.85.1 public working-message and lifecycle APIs; no runtime packages.
- Cross-platform interactive TUI only; RPC and JSON modes are unchanged.
- Uses Pi's public indicator customization and the editor's embedded working row.
- Enable only one extension that owns the working message at a time.
- Phase labels describe received events, not unobservable provider activity.
