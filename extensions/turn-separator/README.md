# turn-separator

A dim horizontal rule between assistant messages that follow tool work, labeled
`Worked for <duration>` and followed by that work block's real usage stats.

```
── Worked for 2m 4s · ↓44.1K ↑318 · cache 93% · 42 tps · ttft 480ms · $0.21 ─────
```

When a new assistant message starts and at least one tool ran since the previous
assistant message, a custom (non-LLM) entry is appended and rendered as a dim,
width-aware rule. No rule appears before the first response of a turn.

Purely event-driven (`tool_execution_start`, `message_start`, `message_update`,
`message_end`): there is no timer or animation loop, so an idle session does no
rendering work and costs no battery.

## What the stats mean

| Segment | Meaning |
|---|---|
| `Worked for 2m 4s` | Wall-clock time from the first tool call of the block to the next assistant message |
| `↓44.1K` | Prompt tokens for the block, cached and uncached combined |
| `↑318` | Output tokens for the block |
| `cache 93%` | Share of prompt tokens served from cache |
| `42 tps` | Output tokens per second of the **latest** response |
| `ttft 480ms` | Time to first token of the **latest** response |
| `$0.21` | Marginal cost of the block |

Token counts and cost come from real provider usage on each finalized response,
summed across the block — never estimated. `tps` and `ttft` are inherently
per-request, so the newest value is shown rather than a meaningless average;
`tps` is suppressed when the streaming window is too short to measure honestly.
Any segment whose data is absent is simply omitted.

Numbers are formatted by the [`footer`](../footer/) helpers, so a token count or
cost reads identically in the rule and in the status bar.

## Width behavior

The rule keeps only what fits, dropping the least informative segment first
(`ttft`, then `tps`, then `cache`, then tokens, then cost). Duration is pinned and
dropped last; when even that will not fit, the rule renders bare.

```
100 │ ── Worked for 2m 4s · ↓44.1K ↑318 · cache 93% · 42 tps · ttft 480ms · $0.21 ──
 64 │ ── Worked for 2m 4s · ↓44.1K ↑318 · cache 93% · $0.21 ─────
 48 │ ── Worked for 2m 4s · ↓44.1K ↑318 · $0.21 ─────
 34 │ ── Worked for 2m 4s · $0.21 ─────
 24 │ ── Worked for 2m 4s ───
 14 │ ─────────────
```

Stats are stored in the session entry, so a resumed or reloaded session redraws
the same numbers. Entries written before stats existed still render their
duration-only label.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`appendEntry`, `registerEntryRenderer`, lifecycle events).
- **Depends on extensions:** [`footer`](../footer/) for shared number formatting and the priority-drop layout helper.
- **Used by extensions:** None.
- **Third-party packages:** None.
