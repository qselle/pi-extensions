# background-jobs

Managed shell processes with bounded logs, cursor-based reads, stdin, and a live
job panel. Jobs are owned by the current Pi session and cleaned up on shutdown.

## Usage

Managed `bash` is the default entry point. Job controls activate after a command
yields, or when inspecting retained jobs through `/jobs`. The redundant
`job_start` alias remains registered but is not enabled automatically.

```text
/jobs                    Live overview with IDs, states, and recent output
/ps                      Alias for /jobs
/jobs output <id>        Follow recent output for one job
/jobs stop <id>          Request termination of one job
/jobs stop all           Request termination of every active job
```

With this extension enabled, `bash` uses the managed executor. It accepts the
usual `command` and `timeout` (seconds), plus `yield_ms` (default 1000), optional
`name`, `pty`, `columns`, and `rows`. Quick commands finish inline. Longer commands
return a job ID; a returned ID is not evidence of success. Check `job_wait` for
the final status and exit code. Commands failing during the initial wait return
a tool error. Cancelling the initial wait stops the command; cancelling a later
`job_wait` leaves it running. The four-job limit also applies to bash calls.

When `tool-render` is enabled, its compact bash appearance is retained regardless
of extension load order. Status and job ID remain visible above collapsed output.
Disable this extension to restore Pi's built-in bash execution; the renderer still
works independently. Pi's user-entered `!` shell commands are unchanged.

The agent can also use:

- `job_start`: command, descriptive name, optional `yield_ms` (default 1000,
  maximum 30000), optional `timeout_seconds` (1–86400), and optional `pty: true`.
  PTYs accept `columns` (10–500, default 100) and `rows` (2–200, default 30).
  No timeout is imposed
  when omitted. Short commands return their completed result; longer commands
  return a job ID while continuing in the background.
- `job_list`: inspect active and recently finished jobs.
- `job_output` / `job_wait`: read output using the previous result's `cursor`.
  `job_wait` waits for completion or its deadline; cancelling that wait leaves the
  job managed. `more` indicates another output page is available immediately.
- `job_write`: write literal stdin text, optionally sending EOF. Cancelling or
  timing out a backpressured pipe write closes stdin; it does not kill the process.
  PTYs accept terminal control bytes such as `\u0003` (Ctrl+C) and `\u0004`
  (Ctrl+D). They reject `eof: true`: a terminal cannot half-close its input.
  Ctrl+D follows the child’s terminal settings; raw-mode programs may interpret
  it differently. Use `job_stop` for unconditional process cleanup.
- `job_resize`: change a running PTY’s columns and rows.
- `job_stop`: TERM followed by KILL after three seconds if still active.

Run the command in the foreground; do not use `nohup`, `disown`, or `setsid` to
escape management. Four jobs can run concurrently; the most recent 24 jobs are
retained. The shared overlay shows active job names on sufficiently large terminals.
The panel shares the transcript viewer's scrolling/search controls and shows the
latest 2000 characters per job. Commands and control tools do not send completion
messages to the model or trigger extra turns; use a wait when results are needed.

Each job retains at most 64000 UTF-16 characters and each tool read returns at
most 12000. Cursors are absolute character offsets, not byte offsets. Eviction is
reported as `lost`; reads preserve Unicode character boundaries. Output from
stdout and stderr is merged in arrival order. Terminal controls are removed
incrementally, including escape sequences split across chunks.

Known questionnaire secret values are redacted from metadata and output before
they reach logs or UI. Split prefixes are held until more output arrives.
Redaction handles literal values and ANSI color interruptions, not arbitrary
encodings or files written by commands. Secrets introduced through job stdin
remain known to that job during session teardown.

## Dependencies and limitations

- Foreground waits stream bounded output updates, coalesced to at most ten output
  refreshes per second, with elapsed-time updates for quiet commands. Cancelling
  or finishing the tool detaches its streaming listeners and timers.

- Pi 0.87.0 public shell, tool, session, and overlay APIs; Node.js built-ins;
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
  PTY integration tests run under Node.js 22.18+ with TypeScript stripping.
  macOS and Linux ARM64 container PTYs and POSIX process cleanup have been verified
  here under Node.js 26.8.2. Windows still needs host testing.
- PTYs provide a real terminal to the child, including resizing and input echo.
  The job viewer displays sanitized output history, not a full-screen terminal
  emulator. Cursor-moving applications may therefore produce repeated lines.
  Managed `bash` and `job_start` use the same execution service.
- Managed `bash` preserves Pi 0.86's `strict: "prefer"` JSON-schema sampling
  preference; Pi falls back on providers without strict-schema support.
- Pi session/model environment fields are refreshed for each launch.
- Shutdown waits for cleanup and removes listeners/timers. A shared synchronous
  process-exit reaper is a last resort; no signal handlers override Pi's shutdown.
  Processes that deliberately escape the process group cannot be guaranteed cleanup.
- Reload/session replacement stops running processes. Bounded, redacted start and
  completion records are saved as Pi custom session entries, including the final
  2000-character output tail. Full logs remain in memory. The recent-job list is
  limited to 24 entries; older saved jobs remain readable by ID.
- Yielded start cards update once to their final state. Output, wait, and write
  cards remain observations at their original timestamps. After reload, a start
  without a saved completion shows “completion unknown”; no process is resumed
  or targeted using a saved PID. History follows the loaded session branch.
- Session files retain lifecycle records until the session itself is removed.
  Command/cwd metadata is capped at 2000 characters each.

The combined package is checked through Pi's real resource loader in both load
orders. Managed jobs is the sole `bash` owner when present; tool rendering supplies
its style without registering a second executor. Standalone tool-render registers
its `bash` override at session start, after executor owners have loaded.
