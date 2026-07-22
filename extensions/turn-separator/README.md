# turn-separator

A dim horizontal rule between assistant messages that follow tool work, labeled
`Worked for <duration>` in the Codex style.

```
────── Worked for 1m 14s ───────────────────────────────────────────────
```

When a new assistant message starts and at least one tool ran since the previous
assistant message, a custom (non-LLM) entry is appended and rendered as a dim,
width-aware rule. The label shows the elapsed time of that work burst; sub-second
bursts get a bare rule. No rule appears before the first response of a turn.

Purely event-driven (`tool_execution_start` + `message_start`): there is no timer
or animation loop, so an idle session does no rendering work and costs no battery.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`appendEntry`, `registerEntryRenderer`, lifecycle events).
- **Depends on extensions:** None.
- **Used by extensions:** None.
