# prevent-sleep

Keeps the computer awake while the agent is actively working, so a long run —
or a self-driving [`goal`](../goal/) — doesn't stall because your Mac idled to
sleep.

The wake lock is held from `agent_start` until the run **settles**
(`agent_settled`), so it spans thinking, tool calls, retries, and compaction
recovery. A goal stays covered because the agent is working throughout each
turn (the gaps between a goal's turns are momentary). When the agent is genuinely
idle — including a blocked/paused goal — the lock is released and the machine can
sleep normally.

| Platform | Mechanism |
|----------|-----------|
| macOS | `/usr/bin/caffeinate -i -w <pi-pid>` — prevents idle **system** sleep (not the display) and releases if pi exits |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block … sleep infinity` |
| other | no-op |

Fully **event-driven** (no timers).

## Commands

- `/prevent-sleep` — show status (on/off + whether the lock is currently held)
- `/prevent-sleep on` / `/prevent-sleep off` — toggle for this session

Disable it permanently via `pi config`.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`agent_start`, `agent_settled`).
- **System:** macOS `caffeinate` or Linux `systemd-inhibit`.
- **Depends on extensions:** None.
- **Used by extensions:** None.
