# notify

Native desktop notifications for agent activity, so you can context-switch away
and get pinged when there's something to look at.

Fires a **native OS banner** (macOS `osascript`, Linux `notify-send`) plus a
**terminal bell** when:

- the agent **finishes a turn** — with a short preview of the reply;
- a **tool failed** during the turn — folded into the turn-complete ping;
- the agent **needs input** — a `questionnaire` tool call.

Only fires when your terminal tab is **unfocused** (tracked via focus-reporting
escape sequences on Ghostty / iTerm / Kitty / Warp / WezTerm — no point pinging
when you're already looking). Stays quiet while a self-driving [`goal`](../goal/)
is active, dedupes identical pings within 5s, and is fully **event-driven (no
timers)**.

```
┌─────────────────────────────┐
│ pi: done                    │
│ Shipped the notify extension│
└─────────────────────────────┘   + a terminal bell (dock bounce / tab marker)
```

## Config

`~/.pi/agent/notify.json`:

```json
{ "enabled": true, "banner": true, "bell": true }
```

- `banner` — native OS banner via `osascript`/`notify-send`.
- `bell` — terminal bell (each terminal surfaces it as a dock bounce / tab marker).

## Commands

- `/notify` — show status
- `/notify on` / `/notify off` — toggle

## Notes

- Banners need OS permission the first time (macOS: allow notifications for your
  terminal). If `osascript`/`notify-send` is unavailable, the bell still fires.
- Focus detection falls back to always-notify on terminals that don't report
  focus, and in non-TTY / non-interactive modes.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`onTerminalInput`, `events`, `agent_settled`), plus `osascript` (macOS) or `notify-send` (Linux).
- **Depends on extensions:** None (reads `goal:changed` off the event bus if present).
- **Used by extensions:** None.
