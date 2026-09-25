# schedule

When [`telegram`](../telegram/) is enabled, failed scheduled turns, failed wakeups, unreadable/unwritable queues, and unconfirmed completion saves send one attention card to the owning session's destination. Cards contain only task kind/ID and a fixed status explanation; scheduled prompts, local paths and raw error text stay in Pi. Successful completion and successful user pause/stop remain quiet. An interrupted turn sends no warning unless its paused state cannot be saved safely. Telegram is optional and `/telegram off` disables remote alerts without changing the schedule.

If a turn completed but its completion could not be saved, inspect its outcome before retrying so work is not repeated. Queue errors stop further dispatch until the queue can be loaded again. These events use the public `schedule:attention` channel and never initiate an automatic retry.

Stores project reminders and five-field cron prompts under Pi's agent directory.

## Usage

Schedule control tools stay inactive until project tasks are created or loaded.
Use `/remind` or `/cron` to add a task.

```text
/remind 30m -- check the deployment
/remind at 2026-08-10T09:00:00+02:00 -- prepare release notes
/cron 0 9 * * MON-FRI --tz Europe/Berlin -- review CI
/cron */15 * * * * --max-runs 20 -- check the rollout
/schedule status
/schedule view
/schedule pause|resume|stop <id>
/schedule stop all
```

Absolute reminders require ISO 8601 with `Z` or a numeric UTC offset. Cron accepts minute, hour, day of month, month, and day of week, including lists, ranges, steps, month/day names, and standard day-of-month/day-of-week OR behavior. `--tz` accepts an IANA timezone; otherwise the current machine timezone is captured.

`/schedule view` opens a scrollable, searchable snapshot with full prompts, task
IDs, cadence, next run, delivery state and stop/pause reasons. Press `/` to search
and `q` or Escape to close; reopen to refresh. Session navigation closes the panel.
Outside the TUI, it prints the full snapshot. `/schedule status` keeps its compact
plain-text summary. All times in the panel use explicit UTC timestamps.

`get_schedules` lists tasks and `schedule_stop` stops one. Model tools cannot create schedules.

Storage and delivery:

- Each project has an owner-only JSON queue and process lease.
- A due task is marked pending before Pi wakes and completes only after the turn settles.
- Missed cron runs coalesce; they are not replayed as a backlog.
- Another Pi process for the same project sees the queue read-only while the lease is held; an idle standby does not occupy the footer status row.
- Failures and interruptions pause the task with its pending delivery preserved.
- Failed saves roll back the change; queued or running deliveries retain their owner.

Limits: 50 tasks per project; reminders from 1 minute to 365 days; cron defaults to 50 runs and accepts 1–500.

Tasks do not run while Pi is closed. Overdue work runs when an owning persistent session next opens and becomes idle. Scheduled turns use the current project and working tree. A wakeup does not grant new authority for external or destructive actions.

## Dependencies and limitations

- Uses Pi's public extension API, Node.js standard-library modules, and host-provided `typebox`.
- No third-party runtime packages or OS service.
- Delivery requires a persistent TUI or RPC session.
- IANA timezone support comes from the JavaScript runtime. Spring-forward gaps are skipped and repeated fall-back minutes are deduplicated.
