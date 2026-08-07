# schedule

Persist one-shot reminders and five-field cron prompts per project. Unlike `loop` and `monitor`,
schedule intent lives in an owner-only file under Pi's agent directory rather than only in one
transcript.

```text
/remind 30m -- check the deployment and handle failures
/remind at 2026-08-10T09:00:00+02:00 -- prepare the release notes
/cron 0 9 * * MON-FRI --tz Europe/Berlin -- review open CI and PR feedback
/cron */15 * * * * --max-runs 20 -- check the rollout
/schedule status
/schedule pause <id>
/schedule resume <id>
/schedule stop <id>
/schedule stop all
```

Cron supports five fields—minute, hour, day of month, month, and day of week—with lists,
ranges, steps, `JAN`–`DEC`, and `SUN`–`SAT`. When both day-of-month and day-of-week are restricted,
traditional cron OR semantics apply. An IANA timezone is explicit with `--tz`; otherwise the
machine's current timezone is captured when the task is created.

Absolute reminders require an ISO-8601 date-time with an explicit `Z` or numeric UTC offset, as
shown above. This avoids locale-dependent dates and machine-local timezone ambiguity.

## Durability, delivery, and ownership

- Each resolved project path has a separate JSON queue under the Pi agent directory. Writes are
  atomic, files are owner-only, symlinks and oversized/cross-project stores are rejected, and a
  per-project process lease prevents two Pi processes from delivering the same task concurrently.
- One-shot reminders can be 1 minute to 365 days away. Cron tasks default to 50 runs and can be
  bounded from 1 to 500. At most 50 active or paused tasks are retained per project.
- A due delivery is durably marked pending before Pi is woken. It is completed or advanced only
  after the agent turn settles, giving crash recovery at-least-once behavior. Missed cron
  occurrences coalesce rather than replaying a backlog.
- Esc, provider errors, persistence failures, and wake failures pause the task while preserving a
  pending delivery for explicit inspection and resume.
- Hidden delivery markers are removed from later model context. `/schedule status` and
  `get_schedules` expose timing, ownership, run counts, pending delivery, and the store path.

The lease owner is the only writable session. Other Pi processes opened on the same project show
the queue read-only until ownership is released. This avoids duplicate execution without relying
on an OS daemon.

## Important limitation

The queue is durable, but this extension is not a background service: nothing executes while Pi
is closed. Overdue work is delivered when an owning TUI or RPC session for that project next
opens and becomes idle. For hard deadlines or unattended execution, use a supervised service such
as GitHub Actions, systemd, launchd, or cron, with its own credentials, logs, retries, and alerts.

Scheduled turns run in the current project session; they do not create an isolated Git worktree.
That deliberate limitation keeps task authority, repository state, and user-visible context
coherent. Use isolated CI or a supervised runner when worktree isolation is required.

As with every automation here, a wakeup grants no new authority to push, deploy, delete, publish,
purchase, or contact people. Model tools may list or stop schedules but cannot create them.

## Dependencies and platform limitations

- **Configuration:** none; reminders, cron expressions, timezone, prompts, and run bounds are
  explicit commands.
- **Runtime dependencies:** Pi's public extension API and `typebox`, supplied by the host.
- **Third-party runtime packages:** none.
- **Timezone behavior:** IANA zones come from the JavaScript runtime. A repeated fall-back wall
  clock minute is de-duplicated; a nonexistent spring-forward minute is skipped.
- **Modes:** persistent TUI and RPC sessions only for delivery.
