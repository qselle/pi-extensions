# schedule

Stores project reminders and five-field cron prompts under Pi's agent directory.

## Usage

```text
/remind 30m -- check the deployment
/remind at 2026-08-10T09:00:00+02:00 -- prepare release notes
/cron 0 9 * * MON-FRI --tz Europe/Berlin -- review CI
/cron */15 * * * * --max-runs 20 -- check the rollout
/schedule status
/schedule pause|resume|stop <id>
/schedule stop all
```

Absolute reminders require ISO 8601 with `Z` or a numeric UTC offset. Cron accepts minute, hour, day of month, month, and day of week, including lists, ranges, steps, month/day names, and standard day-of-month/day-of-week OR behavior. `--tz` accepts an IANA timezone; otherwise the current machine timezone is captured.

`get_schedules` lists tasks and `schedule_stop` stops one. Model tools cannot create schedules.

Storage and delivery:

- Each project has an owner-only JSON queue and process lease.
- A due task is marked pending before Pi wakes and completes only after the turn settles.
- Missed cron runs coalesce; they are not replayed as a backlog.
- Another Pi process for the same project sees the queue read-only while the lease is held.
- Failures and interruptions pause the task with its pending delivery preserved.

Limits: 50 tasks per project; reminders from 1 minute to 365 days; cron defaults to 50 runs and accepts 1–500.

Tasks do not run while Pi is closed. Overdue work runs when an owning persistent session next opens and becomes idle. Scheduled turns use the current project and working tree. A wakeup does not grant new authority for external or destructive actions.

## Dependencies and limitations

- Uses Pi's public extension API, Node.js standard-library modules, and host-provided `typebox`.
- No third-party runtime packages or OS service.
- Delivery requires a persistent TUI or RPC session.
- IANA timezone support comes from the JavaScript runtime. Spring-forward gaps are skipped and repeated fall-back minutes are deduplicated.
