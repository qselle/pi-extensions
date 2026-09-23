# turn-stats

Durable full-run summaries, separate from the per-response timing in turn-separator.

## Usage

`/turn-stats compact|full|hide` sets transcript telemetry for the current branch,
including work-block separators. The choice survives reload. Compact is the
default: one compact completion row, with no separate horizontal rule. Work-block
rules also show recorded usage by default. Full adds detailed accounting; hide
removes both displays while continuing to record accounting. `/turn-stats` still
shows the full latest totals. Failed/interrupted runs use semantic colors.

Every settled agent run with responses or tools adds a compact transcript entry:

```text
 Turn 42s · in 1.2K · out 2.1K · $0.04 · cache hit 88% · 48 tokens/s · first token 320ms · 3 replies · 2 tools · finished 14:32:05
```

`Turn 42s` measures the whole agent run, including its replies, tool work and
provider waits. It is separate from each `Worked for` block. `finished 14:32:05`
marks when that run completed, not its duration or the current time.
Internal restarts for retries, compaction or pre-settlement continuation stay in
the same turn until Pi emits settlement; they do not reset its totals or clock.

The turn duration uses one accent color, labels are muted, values use normal text, and
separators are dim. Warning/error colors are reserved for partial usage,
interruptions and failures. Compact stays exactly one row at every positive terminal width. It drops
the clock, cache counters, response/tool counts, latency, rate, cache hit, tokens,
then cost as space runs out; duration and failure indicators have highest priority.
Expand the entry or use `/turn-stats full` for every metric, wrapped to the viewport.
The optional clock uses the local timezone and saved completion time in 24-hour
`HH:mm:ss` form. Elapsed duration uses a separate monotonic clock. Older entries use Pi's
saved entry timestamp when available and omit the clock when it is unknown.

`in` is fresh input and `out` is output. Wide views also show `cache read` and
`cache write` counts. Compact omits known-zero cache counters, zero tool counts and
unmeasured timing; full details retain every category and its measurement coverage.
Expanded `prompt` sums fresh input, cache reads and cache writes across the run.
`cache hit` is the cache-read share of complete
prompt volume, including `0%` when nothing was cached; it shows `?` for partial
prompt data. A known empty prompt omits cache hit in compact and shows `—` in full.
Unknown usage values show `?`,
partially reported totals show `≥`, and known zero remains zero. Expand for exact
missing-data counts and measurement explanations. Errors, interruptions and
failed tools stay visible in compact mode.
`/turn-stats` reports the current run or the latest recorded summary on the current
branch, including after reload. Failed tools and interrupted/error responses are
visible; “settled” describes the lifecycle event, not proof the task succeeded.

Missing usage is reported explicitly, separately for each category. Known zero
values remain zero. A partial total is the sum of reported values only. Timing
covers the entire agent run, including tool execution and provider waits; it is
not model token throughput. Queued follow-ups belong to their actual agent run.

The completion row includes mean request-to-first-output latency (`first token`)
and aggregate streaming `tokens/s`. Partial timing coverage is always marked
when that metric fits, such as `(2/3 replies)`; expanded details also show complete sample
counts. First output can be nonempty text, thinking or tool-call data; empty block
starts and empty deltas do not establish a timing anchor. Rate divides recorded output tokens by the sum
of measured streaming windows, excluding tool execution and initial waits; it is
not an average of per-response rates. Windows shorter than 250 ms or lacking valid
usage are excluded from rate measurements. Missing anchors remain unknown.
Retries use the latest request anchor; this is not total retry latency. Streaming
windows can include provider stalls and reasoning, so the rate is an observation
of the run, not a provider benchmark. Older saved summaries lack these measurements
and remain readable.

## Dependencies and limitations

- Pi public lifecycle, custom entries, branch history and rendering APIs; no new
  third-party dependencies. Uses shared footer and separator number formatting.
- No network calls, timers or prompt text in summary records. These custom entries
  are UI metadata and are not injected into model context.
- Main-agent assistant usage only. Child agents and independent title/side-chat
  requests are excluded; use usage-export for recorded child-agent accounting.
- Recorded costs depend on the provider adapter and are not authoritative billing.
- A crash or session change before settlement does not fabricate a completed
  summary. Interrupted responses are counted when the run subsequently settles.
- Cross-platform; compact receipts fit one row and expanded details wrap within
  the viewport width.
