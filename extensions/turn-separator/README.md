# turn-separator

Adds a width-aware timing and usage rule before an assistant message that follows tool work.

## Usage

The default compact rule shows elapsed work time. Expanding it shows recorded
usage. `/turn-stats compact|full|hide` (when turn-stats is loaded) controls both
transcript telemetry displays for the current branch, without disabling recording.

```text
── Worked for 2m 4s · ↓44.1K ↑318 · cache 93% · 42 tps · ttft 480ms · $0.21 ──
```

The fields are:

- wall time from the first tool call to the next assistant message
- prompt and output tokens for finalized responses in the block
- prompt-cache hit rate
- tokens per second and time to first token for the latest response
- cost recorded by Pi (provider/adapter-dependent, not authoritative billing)

Work blocks reset at agent start/settlement and session navigation/shutdown;
a previous turn cannot contribute usage or pending work to the next one.
A latest response without measured latency or throughput omits those fields
instead of inheriting the prior response's timing. These are work-block totals,
not a summary of the entire user turn.

Missing fields are omitted. Narrow terminals drop `ttft`, throughput, cache rate, tokens, and cost in that order before dropping duration. Stored session entries preserve the same display after reload.

The extension is event-driven and has no command, configuration file, or timer.

## Dependencies and limitations

- Uses Pi's public lifecycle, message, session-entry, and renderer APIs.
- Imports formatting and width-priority helpers from [`footer`](../footer/).
- No third-party packages.
- Interactive TUI only; cross-platform.
