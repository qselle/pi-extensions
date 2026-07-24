# notify

Native desktop notifications for agent activity, so you can context-switch away
and get pinged when there's something to look at.

Posts a **terminal-owned desktop notification** — for Ghostty/WezTerm via an
`OSC 777` escape, for iTerm2 via `OSC 9` — plus a **terminal bell**, when:

- the agent **finishes a turn** — with a short preview of the reply;
- a **tool failed** during the turn — folded into the turn-complete ping;
- the agent **needs input** — a `questionnaire` tool call.

Because the terminal itself posts the notification, **clicking it focuses your
terminal window** (unlike `osascript`, which posts from Script Editor and can't
redirect). On terminals without OSC-notification support it falls back to a
native notifier (`osascript` on macOS, `notify-send` on Linux).

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

- `banner` — the desktop notification (OSC escape, or `osascript`/`notify-send` fallback).
- `bell` — terminal bell (each terminal surfaces it as a dock bounce / tab marker).

## Commands

- `/notify` — show status
- `/notify on` / `/notify off` — toggle
- `/notify test` — fire a sample notification now (bypasses the focus check) to verify click-to-focus

## Notes

- Ghostty, WezTerm, and iTerm2 post the notification themselves, so clicking it
  focuses the terminal. On other terminals it falls back to `osascript`/
  `notify-send`, which may need one-time OS permission and won't focus the window.
- Focus detection falls back to always-notify on terminals that don't report
  focus, and in non-TTY / non-interactive modes.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`onTerminalInput`, `events`, `agent_settled`); a terminal with OSC-9/777 notifications (Ghostty/WezTerm/iTerm2), else `osascript` (macOS) or `notify-send` (Linux).
- **Depends on extensions:** None (reads `goal:changed` off the event bus if present).
- **Used by extensions:** None.
