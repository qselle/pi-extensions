# loop

Run a prompt again on a bounded cadence without manually re-prompting Pi. A loop is
session-scoped: it wakes only while the Pi session is open, survives reloads and session
resume through transcript state, and never installs an OS daemon or edits a crontab.

```text
/loop
/loop 15m
/loop 5m check whether the deployment finished and address any failure
/loop watch CI and review comments until the pull request is green
/loop status
/loop pause <id>
/loop resume <id>
/loop stop <id>
/loop stop all
```

Bare `/loop` starts a model-paced maintenance loop. `/loop 15m` runs the same maintenance
prompt on a fixed cadence. The prompt is loaded in this order:

1. `<project>/.pi/loop.md` when Pi trusts the project
2. the user's Pi agent directory `loop.md`
3. a built-in bounded maintenance prompt

The file is re-read at each wake, so edits apply to the next iteration. Symlinks, empty
files, and prompts over 25,000 characters are ignored.

An explicit interval uses a fixed cadence. An explicit prompt without one is dynamic: each iteration calls
`loop_schedule` to choose its next delay between one minute and one hour. Both modes run an
initial iteration immediately. A trailing cadence is also accepted:

```text
/loop check the deployment every 10m
```

## Model tools

| Tool | Purpose |
|---|---|
| `loop_schedule` | Schedule the next dynamic iteration with a 60–3600 second delay |
| `loop_stop` | Stop the loop that owns the current agent turn |
| `get_loops` | Inspect loop status, cadence, iterations, and next wakeups |

The model cannot create a loop on its own. Starting one requires the explicit `/loop`
command. Fixed loops keep their configured cadence until the user or model stops them.

## Bounds and lifecycle

- Up to 8 active or paused loops per session.
- Each loop stops after 25 iterations or twelve hours, whichever comes first.
- A loop pauses before firing when context usage is at least 90%.
- Due prompts fire only when Pi is idle and has no queued user messages.
- Missed fixed-interval runs coalesce into one wakeup rather than replaying a backlog.
- If a dynamic iteration forgets to schedule itself, the extension arms one 20-minute
  fallback. A second consecutive omission stops the loop.
- Interrupting an owning iteration with Esc pauses the loop. Provider errors also pause it,
  preserving the reason for inspection and an explicit `/loop resume`.
- Loop wake messages are small hidden markers. The full task is expanded only for the
  owning turn and old markers are removed from model context.

User interruption, tool permissions, project trust, and the normal Pi safety model still
apply. A loop wakeup is a trigger, not new authorization for destructive commands, external
writes, pushes, or deployments.

## Why this is not durable cron

This extension is for interactive monitoring and short recurring work: CI, deploys, review
comments, slow jobs, and multi-pass checks. It deliberately does not promise execution while
Pi is closed. Long-lived daily or weekly automation belongs in GitHub Actions, systemd,
launchd, a real cron service, or another supervised runner where locking, credentials,
logging, retries, and failure delivery can be managed independently of one chat session.

This separation also keeps `loop` distinct from [`goal`](../goal/): `goal` continues toward a
known completion condition as soon as each agent run settles, while `loop` waits for time or
external state to change before running the same prompt again.

## Dependencies and limitations

- **Configuration:** optional `.pi/loop.md` project prompt or user-level `loop.md`; explicit
  command prompts need no configuration.
- **Runtime dependencies:** Pi's public extension API and `typebox`, both supplied by the host.
- **Third-party runtime packages:** none.
- **Modes:** persistent TUI and RPC sessions only.
- **Timing:** in-process JavaScript timers use local wall-clock time and are not exact real-time
  scheduling. Computer sleep or a closed Pi session delays a due run until the session is
  active again.
- **Cadence syntax:** duration intervals only (`60s`, `5m`, up to `1h`); calendar cron
  expressions are intentionally unsupported.
