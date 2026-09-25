# turn-separator

Optional quiet timing rules between assistant responses that follow tool work.
Off by default: normal tool loops show their results and one final receipt from
[`turn-stats`](../turn-stats/), without repeated token, cache, and cost summaries.

## Usage

```text
/turn-separator on      Show per-step timing
/turn-separator off     Hide it, including old saved work-block receipts
/turn-separator toggle  Toggle it (also the default action)
/turn-separator status  Inspect the current setting
```

The choice persists on the current session branch and survives reload. Optional
`$PI_CODING_AGENT_DIR/turn-separator.json` supplies the default for branches without
a saved choice:

```json
{ "enabled": false }
```

Enabled rules use the theme's dim color and put measured response timing at the
right edge:

```text
────────────────────────────── first token 480ms · 42 tokens/s ─
─ Worked for 1m 14s ─────────── first token 480ms · 42 tokens/s ─
```

Only steps lasting at least a minute receive an elapsed-work label. Duration
covers the interval from one assistant response starting to the next, including
generation and intervening tools. One step may contain several tools. It uses a
monotonic clock and does not reset at internal provider round trips.

Response timing comes from `turn-stats`' finalized-response event, using the same
measurements as the final receipt. Missing measurements are omitted; a response
without timing clears the previous sample. Without `turn-stats`, rules still work
but omit model timing. No tokens or costs are repeated here. Legacy work-block
entries render their timing only. Enabling separators cannot recreate steps that
were never recorded while they were off.

Rules reserve two terminal columns to prevent wrapping. Narrow terminals drop
the elapsed label and then optional timing fields. `/turn-stats hide` also hides
enabled rules; `compact` or `full` restores them only when explicitly enabled.
Session changes, shutdown, settlement, and toggles clear pending work.

## Dependencies and limitations

- Uses Pi's public lifecycle, event bus, custom entry, command and renderer APIs.
- Optional [`turn-stats`](../turn-stats/) supplies model timing; shared formatters
  are internal code, with no third-party packages.
- Cross-platform; transcript rendering applies to the TUI. No network, timer,
  prompt text, or duplicate usage accounting is involved.
