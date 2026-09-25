# monitor

Runs an explicit shell command on a cadence and wakes Pi only when its result matches a policy.

## Usage

Monitor control tools stay inactive until a monitor is created or restored.
Use `/monitor` to start one.

```text
/monitor 30s -- gh pr checks
/monitor 1m --on failure -- npm test
/monitor 5m --on success -- curl -fsS https://example.test/health
/monitor 30s --on change --max-runs 40 -- ./scripts/status
/monitor status
/monitor view
/monitor pause|resume|stop <id>
/monitor stop all
```

Policies:

- `change` (default): establish a silent baseline, then wake when status or output changes.
- `failure` or `success`: wake on the first match and when the matching result changes.
- `always`: wake after every run.

When [`telegram`](../telegram/) is enabled, each actionable result also sends one brief session-topic notification with the monitor ID, check count and exit status. Failure to start or finish the alert turn sends a pause warning. These notifications exclude commands, captured output and raw error text; unchanged results and user cancellations remain quiet. `--on always` requests a notification for every check. `/telegram off` disables Telegram delivery without stopping local monitoring.

When quiet polling reaches its run or 12-hour limit, one attention card explains that monitoring ended. An overdue monitor restored after that lifetime also reports its stop once. A final actionable result already has its own update and does not add a second expiration card.

The model receives the full bounded result in Pi and is asked to send only additional actionable conclusions through `notify_user`, or use `questionnaire` when your decision is needed. A monitor does not automatically turn every command failure into a question.

Only `/monitor` can create or change a monitor command. `get_monitors` lists monitors and `monitor_stop` stops one.

`/monitor view` opens a scrollable, searchable snapshot with full commands,
check counts, UTC timestamps, wake conditions, exit status and pause/stop reasons.
Use `/` to search, `n`/`N` to move between matches and Escape to close. Reopen to
refresh; session navigation closes the panel. In RPC mode it prints the same full
details. Viewing a monitor does not run its command or wake the model. Captured
command output is not retained in the panel; an unobserved exit status stays unknown.

## Dependencies and limitations

- 4 active or paused monitors.
- Intervals from 10 seconds to 1 hour.
- 100 runs by default, up to 500, and a 12-hour lifetime.
- 5-minute timeout per command.
- Retains 10 KiB from each output stream while hashing complete output for change detection.
- Runs only while a persistent session is open, idle, and has no queued user messages.

The full command is stored in session state. Do not include secrets. Interruptions and provider errors pause the monitor. A wakeup does not grant permission for unrelated external or destructive actions.

Pausing or stopping cancels an in-flight check. Resuming waits for that process to settle; cancelled results do not consume the run limit or trigger an alert.

- Uses Pi's public extension API and host-provided `typebox`.
- Publishes status metadata through `monitor:alert`; Telegram validates events and remains optional.
- No third-party runtime packages.
- Uses `/bin/sh -lc` on POSIX and `cmd.exe` on Windows; command syntax is shell-specific.
- State survives reload, but monitoring stops when Pi closes.
