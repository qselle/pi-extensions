# monitor

Runs an explicit shell command on a cadence and wakes Pi only when its result matches a policy.

## Usage

```text
/monitor 30s -- gh pr checks
/monitor 1m --on failure -- npm test
/monitor 5m --on success -- curl -fsS https://example.test/health
/monitor 30s --on change --max-runs 40 -- ./scripts/status
/monitor status
/monitor pause|resume|stop <id>
/monitor stop all
```

Policies:

- `change` (default): establish a silent baseline, then wake when status or output changes.
- `failure` or `success`: wake on the first match and when the matching result changes.
- `always`: wake after every run.

Only `/monitor` can create or change a monitor command. `get_monitors` lists monitors and `monitor_stop` stops one.

## Dependencies and limitations

- 4 active or paused monitors.
- Intervals from 10 seconds to 1 hour.
- 100 runs by default, up to 500, and a 12-hour lifetime.
- 5-minute timeout per command.
- Retains 10 KiB from each output stream while hashing complete output for change detection.
- Runs only while a persistent session is open, idle, and has no queued user messages.

The full command is stored in session state. Do not include secrets. Interruptions and provider errors pause the monitor. A wakeup does not grant permission for unrelated external or destructive actions.

- Uses Pi's public extension API and host-provided `typebox`.
- No third-party runtime packages.
- Uses `/bin/sh -lc` on POSIX and `cmd.exe` on Windows; command syntax is shell-specific.
- State survives reload, but monitoring stops when Pi closes.
