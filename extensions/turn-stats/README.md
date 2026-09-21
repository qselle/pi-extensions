# turn-stats

Durable full-run summaries, separate from the per-response timing in turn-separator.

## Usage

`/turn-stats compact|full|hide` sets transcript telemetry for the current branch,
including work-block separators. The choice survives reload. Compact is the
default: short turn receipts and timing-only work rules. Full adds detailed usage;
hide removes both displays while continuing to record accounting. `/turn-stats`
still shows the full latest totals. Failed/interrupted runs use semantic colors.

Every settled agent run with responses or tools adds a compact transcript entry:

```text
Turn settled · 42s · 3 responses · 2 tools
```

Expand the entry for input/output tokens, cache reads/writes, recorded cost and
response timing.
`/turn-stats` reports the current run or the latest recorded summary on the current
branch, including after reload. Failed tools and interrupted/error responses are
visible; “settled” describes the lifecycle event, not proof the task succeeded.

Missing usage is reported explicitly, separately for each category. Known zero
values remain zero. A partial total is the sum of reported values only. Timing
covers the entire agent run, including tool execution and provider waits; it is
not model token throughput. Queued follow-ups belong to their actual agent run.

Expanded timing includes mean request-to-first-output latency and aggregate
streaming tokens/second, each with a measured-response count. First output can be
text, thinking or tool-call data. Rate divides recorded output tokens by the sum
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
- Cross-platform; expanded rows clip to the viewport width.
