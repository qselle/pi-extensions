# pi-extensions

A collection of optional extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Install

Requires Pi 0.85.1 (supported host line: 0.85.x). Use Node.js for interactive PTY
jobs; Bun supports pipe jobs. macOS and Linux ARM64 are tested; Windows remains
unverified. Shared internal code is packaged under `lib/` and does not register
additional extensions.

```bash
pi install git:github.com/qselle/pi-extensions
pi config
```

The first command installs the package. Use `pi config` to enable only the extensions you want.

## Choose a small starting set

Use `pi config` to enable only the workflows you use. A practical starting set is
`codex-prompt`, `footer`, `tool-render`, `plan`, `web-search`, `background-jobs`, and
`doctor`. Add `overlay-stack` for workflow cards, `side-chat` for isolated discussion,
and `subagents` when you explicitly delegate work. Decorations, schedules,
monitors and telemetry are optional. Use Pi's built-in `/reload` when changing
extensions; this package has no cross-session reload broker.

[Setup decisions](docs/setup-design.md) explain the extension boundaries and the
current Telegram/session-title integrations.

All 38 extensions together expose 14 model tools in a fresh session. Job and
workflow controls activate when their workflow is used; optional context/image
tools remain opt-in. This reduces tool descriptions without adding a profile
manager. Built-in managed `bash` is the primary job entry point; `job_start` remains
registered as a compatibility alias and is inactive by default.

For a temporary lean checkout session, Pi also supports explicit selection:

```bash
pi --no-extensions -e ./extensions/codex-prompt -e ./extensions/footer -e ./extensions/tool-render -e ./extensions/plan -e ./extensions/web-search
```

## Extensions

| Extension | Purpose |
|---|---|
| [`background-jobs`](extensions/background-jobs/) | Managed pipe/PTY jobs with cursor logs, input, resizing, and cleanup |
| [`cat-buddy`](extensions/cat-buddy/) | Animated cat above the input bar |
| [`code-blocks`](extensions/code-blocks/) | Named code captions and restored syntax highlighting |
| [`codex-prompt`](extensions/codex-prompt/) | Flat `›` editor prompt |
| [`context`](extensions/context/) | Context-window breakdown |
| [`context-journal`](extensions/context-journal/) | Durable session notes and bounded history retrieval |
| [`doctor`](extensions/doctor/) | Read-only dependency and configuration health report |
| [`file-changes`](extensions/file-changes/) | Current and previous run file changes |
| [`fast-mode`](extensions/fast-mode/) | Explicit premium processing requests for the direct OpenAI Responses API |
| [`footer`](extensions/footer/) | Model, context, usage, and cost status |
| [`goal`](extensions/goal/) | Persistent goals that continue across turns |
| [`handoff`](extensions/handoff/) | Reviewed fresh-context continuation with durable checkpoints |
| [`history-search`](extensions/history-search/) | Fuzzy search of the active prompt history |
| [`hyperlinks`](extensions/hyperlinks/) | Clickable terminal paths |
| [`image-history`](extensions/image-history/) | Opt-in older-image deferral with on-demand retrieval |
| [`loop`](extensions/loop/) | Repeated prompts on a bounded cadence with searchable loop inspection |
| [`memory`](extensions/memory/) | Explicit project and global memory |
| [`monitor`](extensions/monitor/) | Shell-command monitoring with conditional wakeups and a searchable command panel |
| [`notify`](extensions/notify/) | Desktop and terminal notifications |
| [`overlay-stack`](extensions/overlay-stack/) | Workflow cards with compact summaries in narrow terminals |
| [`plan`](extensions/plan/) | Current multi-step execution plan |
| [`prevent-sleep`](extensions/prevent-sleep/) | Keep your Mac awake while Pi works; no-op on Linux |
| [`rewind`](extensions/rewind/) | Search earlier prompts, fork before one, and edit it again |
| [`questions`](extensions/questions/) | Structured terminal and Telegram questions |
| [`schedule`](extensions/schedule/) | Persistent reminders, cron prompts, and a searchable schedule panel |
| [`session-search`](extensions/session-search/) | Full-text search across saved sessions |
| [`session-title`](extensions/session-title/) | Automatic session titles and Herdr tab synchronization |
| [`side-chat`](extensions/side-chat/) | Background side conversations |
| [`subagents`](extensions/subagents/) | Isolated child agents |
| [`telegram`](extensions/telegram/) | Session topics, goal notifications, and replies shared across local Pi sessions |
| [`tool-render`](extensions/tool-render/) | Compact built-in tool rendering |
| [`transcript`](extensions/transcript/) | Searchable full-session history with live updates and Markdown |
| [`turn-separator`](extensions/turn-separator/) | Timing and usage between tool-work blocks |
| [`turn-stats`](extensions/turn-stats/) | Durable full-run timing, response/tool counts, and explicit missing-usage accounting |
| [`usage-export`](extensions/usage-export/) | Explicit local JSON/CSV usage exports with missing-value accounting |
| [`verify`](extensions/verify/) | Run focused checks after file edits |
| [`working-status`](extensions/working-status/) | Live phase and elapsed time in the native working indicator |
| [`web-search`](extensions/web-search/) | Keyless Exa search, optional keyed providers, and bounded ax page reading |

See each extension's README for commands, configuration, and limitations. The differences between `loop`, `monitor`, and `schedule` are covered in the [automation comparison](docs/automation-study.md).

## Development

Requires Bun 1.3.14. CI also pins Node.js 26.8.2 for native PTY fixtures.

```bash
bun install --frozen-lockfile
bun run check
```

Pi APIs are peer dependencies supplied by the host. `bun run check` runs TypeScript and the full test suite.

Package archives include runtime TypeScript, extension READMEs, themes, documentation
and the PTY installation helper. Tests and fixtures stay in the source checkout.
Run `bun run check:package` on macOS or Linux to build a temporary archive,
check its contents and load all extensions from it in both orders. It requires
Node, npm, Bun and tar, and reuses installed dependencies without publishing.
The package remains private. CI runs full checks and this archive check on Linux
and macOS; Windows integration remains unverified.

Run `bun run check:install` for an isolated consumer installation. It downloads
the packed artifact's dependencies plus pinned Pi host APIs, prepares node-pty,
executes a native PTY command and loads all extensions in both orders. It needs
network access and the platform's native build prerequisites if prebuilt binaries
are unavailable. Installation scripts are disabled except the explicit node-pty
rebuild and this package's PTY helper. Temporary packages and cache are removed
afterward; the working tree's dependencies and lockfile are not changed.

`bun run check:linux` runs the full suite and archive checks in a disposable
`node:26.8.2-bookworm` container with Bun 1.3.14. Start a local Docker engine first;
the script does not start one or resume existing machines. It mounts a temporary
source snapshot read-only and installs dependencies inside the container. Network
access is required for the image and dependencies. It removes its container and
snapshot afterward; downloaded Docker image layers remain cached. This checks
Linux process/runtime behavior, not desktop notifications. Sleep prevention is macOS-only.
Add `--clean-install` to also verify the archive in a separate Linux consumer
directory with fresh dependencies and a real PTY, instead of reusing the source
checkout's dependencies for the archive check.

`bun run preview:ui` starts an isolated native Pi session in a real PTY and writes
an HTML preview plus terminal cell/text captures to a temporary directory. It
checks active and settled layouts at 100 and 60 columns, workflow hide/show,
transcript search, the doctor overview, and loop inspection with a paused fixture.
All extensions load, but responses and usage are synthetic;
network requests, desktop notifications, automatic titles, Telegram and sleep
prevention are disabled. Your sessions and terminal windows are untouched.
The preview uses Node.js, the existing node-pty dependency, and the development
dependency `@xterm/headless`. It is verified on macOS with Node.js 26.8.2; it needs
a working native PTY installation on other platforms. The fixture session is
removed after exit; captures remain in the reported temporary directory for
review. This is a static terminal-cell preview, not a test of a particular
terminal application's font, graphics, or hyperlink handling.

## License

MIT
