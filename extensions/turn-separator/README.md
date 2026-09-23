# turn-separator

Adds a width-aware timing and usage rule before an assistant message that follows tool work.

## Usage

The default compact rule shows elapsed work time and recorded usage on one line.
`/turn-stats compact|full|hide` (when turn-stats is loaded) controls both
transcript telemetry displays for the current branch, without disabling recording.

```text
── Worked for 2m 4s · in 100 · out 318 · $0.21 · cache hit 98% · 42 tokens/s · first token 480ms ──
```

The fields are:

- elapsed time from the first tool call to the next assistant message, measured
  with a monotonic clock; sub-second work shows `<1s`
- fresh input (`in`) and output (`out`) tokens for finalized replies in the block
- `cache hit`, `cache read` and `cache write` when present; the hit-rate
  denominator includes fresh input, cache reads and writes
- streaming output `tokens/s` and request-to-first-output latency
  (`first token`) for the latest finalized reply
- cost recorded by Pi (provider/adapter-dependent, not authoritative billing)

The leading work duration uses one accent color. Labels are muted, values use
normal text, and the rule/separators are dim. Only partial reported totals use
warning color. Known-zero cache counters are omitted; measured zero timing and
input/output values remain visible.

Work blocks reset at agent start/settlement and session navigation/shutdown;
a previous turn cannot contribute usage or pending work to the next one.
A latest response without measured latency or throughput omits those fields
instead of inheriting the prior response's timing. These are work-block totals,
not a summary of the entire user turn.

First output includes nonempty text, thinking and tool-call data. Empty chunks do
not establish timing anchors. Throughput needs at least 250 ms of streaming and
known output usage; a reported zero is kept, while missing usage is not treated as
zero. Retries use the latest request anchor. Emitting a work separator preserves
the upcoming response's anchor, and duplicate finalized response events are ignored.

New records distinguish known zero (`0`), missing usage (`?`), and partial totals
(`≥`). Cache hit shows `0%` for an uncached known prompt or `?` when prompt usage
is incomplete; known empty prompts omit the rate. Legacy entries remain readable.
Narrow terminals drop cache counters, reply counts, first-token latency,
throughput, cache hit, input/output, then cost before dropping duration.
Labels stay readable instead of becoming abbreviations.
When even the duration cannot fit, the result is a bare rule. Rules never wrap.
Stored session entries preserve the same display after reload.

The extension is event-driven and has no command, configuration file, or timer.

## Dependencies and limitations

- Uses Pi's public lifecycle, message, session-entry, and renderer APIs.
- Imports formatting and width-priority helpers from [`footer`](../footer/).
- Shares the first-output event predicate with [`turn-stats`](../turn-stats/);
  the turn-stats extension itself does not need to be enabled.
- No third-party packages.
- Interactive TUI only; cross-platform.
