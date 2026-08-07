# monitor

Run an explicit shell command on a bounded cadence without spending model turns on unchanged
results. The model wakes only when the selected observation policy becomes actionable.

```text
/monitor 30s -- gh pr checks
/monitor 1m --on failure -- npm test
/monitor 5m --on success -- curl -fsS https://example.test/health
/monitor 30s --on change --max-runs 40 -- ./scripts/status
/monitor status
/monitor pause <id>
/monitor resume <id>
/monitor stop <id>
/monitor stop all
```

`change` is the default. Its first run establishes a silent baseline; a later change in exit
status, timeout state, stdout, or stderr wakes Pi. `failure` and `success` wake on the first
matching observation and again only when that matching result changes. `always` wakes on every
run. Exact repeated failures therefore do not consume repeated model turns.

## Safety and lifecycle

- The shell command can be created only by an explicit `/monitor` command. Model tools can list
  and stop monitors, but cannot create them or change their commands.
- Output is treated as untrusted data and captured incrementally: at most 10 KB from each stream
  is retained while complete streams are hashed for change detection. Older hidden alerts are
  removed from subsequent model context.
- Commands run only while a persistent TUI or RPC session is open, Pi is idle, and no user
  messages are queued. Each run has a five-minute timeout.
- Up to four active or paused monitors are retained. Intervals range from 10 seconds to one hour;
  the default maximum is 100 runs, configurable up to 500; every monitor also expires after
  twelve hours.
- Interrupting an alert turn or encountering a provider error pauses its monitor for explicit
  review and resume.
- A wakeup authorizes handling the observation within the conversation's existing scope. It does
  not grant permission to deploy, push, delete, publish, or contact external systems.

The command is executed through `cmd.exe` on Windows and `/bin/sh -lc` elsewhere. That is useful
for pipelines and redirects, but it also means the entered command has the user's full shell
permissions. Do not put secrets directly in the command because session state retains it.

## Dependencies and limitations

- **Configuration:** none; command, interval, wake condition, and run bound are explicit.
- **Runtime dependencies:** Pi's public extension API and `typebox`, supplied by the host.
- **Third-party runtime packages:** none.
- **Platform:** Windows and POSIX shells are supported as described above; command syntax itself
  is shell-specific. Timeout and shutdown terminate the spawned POSIX process group or Windows
  process tree.
- **Durability:** transcript state survives reloads, but checks do not run while Pi is closed.
  Use the separate `schedule` extension for durable calendar intent and reminders.
