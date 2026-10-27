# background-jobs

Managed shell processes with bounded logs, cursor-based reads, stdin, and a live
job panel. Jobs are owned by the current Pi session and cleaned up on shutdown.

## Usage

Managed `bash` is the default entry point. Job controls activate after a command
yields or you inspect retained jobs through `/jobs`. The `job_start` alias is
registered but inactive by default.

Every managed job tool accepts optional `purpose` display text, including start,
output, wait, list, stdin, resize, and stop. Use a short factual explanation of
what the action checks or changes, without repeating its command or job ID.
Captions appear once in the existing call heading and survive session replay.
They do not enter command execution, stdin, or result output. Known secret values
are redacted before captions are shortened; terminal controls are removed. The
field is optional, so existing calls continue to work. No extra model request or
system-prompt file change is needed.

```text
/jobs                    Live overview with IDs, states, and recent output
/ps                      Alias for /jobs
/jobs output <id>        Follow recent output for one job
/jobs stop <id>          Request termination of one job
/jobs stop all           Request termination of every active job
```

With this extension enabled, `bash` uses the managed executor. It accepts the
usual `command` and `timeout` (seconds), plus `yield_ms` (default 10000, capped
at 30000), `max_chars` (output budget, default 24000, capped at 50000),
`stdin`, optional `name`, `purpose`, `pty`, `columns`, and `rows`. Quick commands
finish inline. Longer commands return a job ID and a hint to call `job_wait`;
use it for the final status and exit code. Commands that fail during the initial
wait return an error result that still carries the job details. Cancelling the
initial wait stops the command, like Pi's built-in bash.

Later `job_wait` and `job_output` waits never stop the job. When the user
interrupts one, or queues a message (checked every 250 ms), the wait returns a
normal result: the output so far, an advanced cursor, and a note that the job is
still running and not hung. Its card shows “interrupted after 12s” or “new
message after 12s”.
The 16-job limit also applies to bash calls.

Pipe jobs start with stdin closed, so commands that read input see EOF instead
of waiting forever. Pass `stdin: true` to keep a pipe open for `job_write`.
PTY jobs always accept input.

Without `name`, a job is labelled with its `purpose`, or else the start of its
command (redacted, at most 60 characters).

When `tool-render` is enabled, its compact bash appearance is retained regardless
of extension load order. Status and job ID remain visible above collapsed output.
Disable this extension to restore Pi's built-in bash execution; the renderer still
works independently. Pi's user-entered `!` shell commands are unchanged.

The optional `purpose` is a short, model-written explanation of what the command
checks or changes, typically 3–8 words. It appears with the command, including
when the compact renderer is disabled. It is display metadata, separate from the
job `name`; it never reaches the process executor and does not expose thinking
blocks. Known secret values and terminal controls are removed before display.
The UI caps it at 160 characters. The schema deliberately imposes no length
validation failure, so an overly long explanation cannot prevent the command
from running. Commands without a purpose keep their existing appearance.

The agent can also use:

- `job_start`: command, descriptive name, optional `yield_ms` (default 1000,
  capped at 30000), optional `timeout_seconds` (1–86400), `max_chars`, `stdin`,
  and `pty: true`. PTYs accept `columns` (10–500, default 100) and `rows`
  (2–200, default 30). No timeout is imposed when omitted. Short commands return
  their completed result; longer commands return a job ID while continuing in
  the background.
- `job_list`: inspect active and recently finished jobs.
- `job_wait`: wait for the job to exit, up to `wait_ms` (default and cap
  300000; larger values are clamped, not rejected), then return its status and
  output. An interrupted wait leaves the job managed.
- `job_output`: read output without waiting (`wait_ms` defaults to 0).
- `job_write`: write literal stdin text, optionally sending EOF. Pipe jobs need
  `stdin: true` at start. Cancelling or timing out a backpressured pipe write
  closes stdin; it does not kill the process. PTYs accept terminal control bytes
  such as `\u0003` (Ctrl+C) and `\u0004` (Ctrl+D). They reject `eof: true`: a
  terminal cannot half-close its input. Ctrl+D follows the child’s terminal
  settings; raw-mode programs may interpret it differently. Use `job_stop` for
  unconditional process cleanup.
- `job_resize`: change a running PTY’s columns and rows.
- `job_stop`: TERM followed by KILL after three seconds if still active.

Run the command in the foreground; do not use `&`, `nohup`, `disown`, or
`setsid` to escape management. The bash guidelines say so and keep Pi's note about
`PI_*` environment variables. Sixteen jobs can run concurrently; the most recent
50 jobs are retained. The shared overlay shows active job names on sufficiently
large terminals. The panel shares the transcript viewer's scrolling/search controls
and shows the latest 2000 characters per job. Commands and control tools do not
send completion messages to the model or trigger extra turns; use a wait when
results are needed.

### Reading output

Every read (`bash`, `job_start`, `job_wait`, `job_output`, `job_write`) accepts
`max_chars` (default 24000, clamped to 200–50000).

- **Omitted cursor:** returns output since the agent's previous read of that job,
  newest first. The extension tracks this position per job, so repeated
  `job_wait {id}` calls never repeat output. When the unread range exceeds the
  budget, the result keeps its last `max_chars` characters (ending at the
  current output end) and starts with
  `[earlier output omitted (N chars); use cursor X to read from the start]`.
- **Explicit `cursor`:** pages forward from that absolute offset; `more`
  indicates another page is available. Explicit reads never move the tracked
  position backwards.

Each job retains at most 128000 UTF-16 characters. Cursors are absolute character
offsets, not byte offsets. Eviction is reported as `lost`; reads preserve Unicode
character boundaries. Output from stdout and stderr is merged in arrival order.
Terminal controls are removed incrementally, including escape sequences split
across chunks.

### Argument aliases

Each tool accepts common spellings from other shell tool sets and renames them
before validation when the canonical name is absent: `job_id`/`jobId` → `id`,
`waitMs` → `wait_ms`, `yield-time_ms`/`yieldMs` → `yield_ms`,
`max_output_tokens` → `max_chars` (×4 characters per token), `maxChars` →
`max_chars`, `reasoning` → `purpose`, `tty` → `pty`, `chars` → `text`,
`close_stdin` → `eof`, `timeout` → `timeout_seconds` (`job_start`), and
`wait: true` → `wait_ms: 300000` (`job_output`). `cursor` passes through.

### Result details

Managed `bash` and job results set `details` for renderers:

| Field | Meaning |
| --- | --- |
| `managed` | Always `true` |
| `id`, `name` | Job ID and label |
| `status` | `starting`, `running`, `stopping`, `completed`, `failed`, `stopped`, `timed-out`, or `interrupted` |
| `exitCode`, `signal` | Process exit code and terminating signal (`null`/absent while running) |
| `startedAt`, `endedAt` | Epoch milliseconds; `endedAt` is absent while running |
| `durationMs` | Elapsed time, so far for active jobs; absent for `interrupted` |
| `cursor`, `more`, `lost`, `omitted` | Read position, another page available, evicted and skipped characters |
| `wait` | For waits: `startedAt`, `limitMs`, `observedAt`, and `end` (`exit`, `output`, `deadline`, `interrupted`, or `message`; unset while waiting) |

Managed `bash` also declares an output schema and returns `structuredContent`,
which programmatic callers such as codemode scripts receive instead of the text.
Field names follow Pi's built-in bash: `output` (the whole retained log, not the
newest-first budget), `truncated`, `exit_code` (absent while running or after a
signal), and `wall_time_seconds`, plus `status` and, while running, `job_id`.

`job_list` details hold `jobs` with `id`, `name`, `status`, `icon`, `exitCode`,
`signal`, `startedAt`, and `endedAt`.

### Cards

Job control tools render their own compact cards: one `•` headline with the
action and purpose, then a gutter with the status line and the last four output
rows. Expanding shows the full result. `job_list` shows a job count and one row
per job.

### Redaction

Known questionnaire secret values are redacted from metadata and output before
they reach logs or UI. Split prefixes are held until more output arrives.
Redaction handles literal values and ANSI color interruptions, not arbitrary
encodings or files written by commands. Secrets introduced through job stdin
remain known to that job during session teardown.

## Dependencies and limitations

Foreground waits stream output at most ten times per second, with elapsed-time updates for quiet commands.

- Pi 1.0 public shell, tool, session, and overlay APIs; Node.js built-ins;
  [`node-pty`](https://github.com/microsoft/node-pty) 1.1.x for PTY jobs.
  Install package dependencies with install scripts enabled. On macOS the root
  postinstall script repairs the packaged spawn helper’s execute permission.
  If install scripts were skipped, run `node scripts/prepare-pty.mjs` once from
  the package root. Platforms without prebuilt binaries need node-pty’s native
  build prerequisites (Python and a C++ toolchain).
- Internal helpers: `overlay-stack`, `transcript`, `working-status`, and the
  `questions` secret registry. Their UI extensions need not all be enabled.
- Uses Pi's portable bash shell resolution. POSIX jobs use dedicated process
  groups, including descendants left after the shell exits. Windows uses
  `taskkill /t /f`; descendant tracking after the parent exits is POSIX-only.
  Windows process cleanup has not been verified on a Windows host.
- Pipe jobs work with Node.js and Bun. PTY jobs require Node.js; Bun is rejected
  before launch because its native PTY behavior failed the runtime check.
  PTYs and cleanup are tested on macOS and Linux ARM64 with Node.js 26.8.2.
- PTYs provide a real terminal to the child, including resizing and input echo.
  The job viewer displays sanitized output history, not a full-screen terminal
  emulator. Cursor-moving applications may therefore produce repeated lines.
  Managed `bash` and `job_start` use the same execution service.
- Shutdown stops managed processes and finishes within the TERM grace period plus
  two seconds; jobs still unsettled then are killed, detached, and marked stopped.
  Processes that escape the process group may survive cleanup. If Pi exits
  without a shutdown, a synchronous exit hook kills live process groups; it is
  shared across reloads and registered only while jobs run.
- When the process group exits but an escaped daemon (for example after
  `setsid`) keeps the output pipes open, the job settles after a 500 ms drain and
  stops reading from those pipes.
- Reload/session replacement stops running processes. Bounded, redacted start and
  completion records are saved as Pi custom session entries, including the final
  2000-character output tail. Full logs remain in memory. The recent-job list is
  limited to 50 entries; older saved jobs remain readable by ID.
- Yielded start cards update once to their final state. Output, wait, and write
  cards remain observations at their original timestamps. After reload, a start
  without a saved completion shows “completion unknown”; no process is resumed
  or targeted using a saved PID. History follows the loaded session branch.
- Session files retain lifecycle records until the session itself is removed.
  Command/cwd metadata is capped at 2000 characters each.
