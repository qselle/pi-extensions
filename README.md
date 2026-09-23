# pi-extensions

Optional extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Install

Requires Pi 0.87.x. macOS and Linux ARM64 are tested; Windows is unverified.
Interactive PTY jobs require Node.js; pipe jobs also work with Bun.

```bash
pi install git:github.com/qselle/pi-extensions
pi config
```

Enable the extensions you want with `pi config`, then use `/reload` to apply changes.
A starting set: `codex-prompt`, `footer`, `tool-render`, `plan`, `web-search`,
`background-jobs`, and `doctor`. Add `overlay-stack` for workflow cards.

For a temporary selection from a checkout:

```bash
pi --no-extensions -e ./extensions/codex-prompt -e ./extensions/footer -e ./extensions/tool-render
```

## Extensions

| Extension | Purpose |
|---|---|
| [`background-jobs`](extensions/background-jobs/) | Managed pipe/PTY jobs with cursor logs, input, resizing, and cleanup |
| [`cat-buddy`](extensions/cat-buddy/) | Animated cat above the input bar |
| [`code-blocks`](extensions/code-blocks/) | Shiki Gruvbox syntax, streaming code captions and native fallback |
| [`codex-prompt`](extensions/codex-prompt/) | Flat `›` editor prompt |
| [`command-palette`](extensions/command-palette/) | Search loaded extension, prompt and skill commands with Ctrl+Shift+P |
| [`context`](extensions/context/) | Context-window breakdown |
| [`context-journal`](extensions/context-journal/) | Working notes and older-message retrieval |
| [`doctor`](extensions/doctor/) | Read-only dependency and configuration health report |
| [`file-changes`](extensions/file-changes/) | Current and previous run file changes |
| [`fast-mode`](extensions/fast-mode/) | Request fast processing for supported OpenAI models |
| [`footer`](extensions/footer/) | Model, context, usage, cost, and local Git status |
| [`goal`](extensions/goal/) | Persistent goals that continue across turns |
| [`handoff`](extensions/handoff/) | Carry a task checkpoint into a fresh session |
| [`history-search`](extensions/history-search/) | Fuzzy search of the active prompt history |
| [`hyperlinks`](extensions/hyperlinks/) | Clickable terminal paths |
| [`image-history`](extensions/image-history/) | Opt-in older-image deferral with on-demand retrieval |
| [`loop`](extensions/loop/) | Repeat a prompt at an interval |
| [`memory`](extensions/memory/) | Explicit project and global memory |
| [`monitor`](extensions/monitor/) | Run shell checks and wake Pi when results match |
| [`notify`](extensions/notify/) | Desktop and terminal notifications |
| [`overlay-stack`](extensions/overlay-stack/) | Workflow cards with compact summaries in narrow terminals |
| [`plan`](extensions/plan/) | Current multi-step execution plan |
| [`prevent-sleep`](extensions/prevent-sleep/) | Keep your Mac awake while Pi works; no-op on Linux |
| [`rewind`](extensions/rewind/) | Search earlier prompts, fork before one, and edit it again |
| [`questions`](extensions/questions/) | Structured terminal and Telegram questions |
| [`schedule`](extensions/schedule/) | Project reminders and cron prompts |
| [`session-search`](extensions/session-search/) | Full-text search across saved sessions |
| [`session-title`](extensions/session-title/) | Automatic session titles and Herdr tab synchronization |
| [`side-chat`](extensions/side-chat/) | Background side conversations |
| [`subagents`](extensions/subagents/) | Isolated child agents |
| [`telegram`](extensions/telegram/) | Session topics, Markdown notifications, diagnostics, and question replies |
| [`tool-render`](extensions/tool-render/) | Compact tools, soft command panels and brief command-purpose captions |
| [`transcript`](extensions/transcript/) | Searchable full-session history with live updates and Markdown |
| [`turn-separator`](extensions/turn-separator/) | Timing and usage between tool-work blocks |
| [`turn-stats`](extensions/turn-stats/) | Per-run timing, response counts, and usage |
| [`usage-export`](extensions/usage-export/) | Export recorded usage as JSON or CSV |
| [`verify`](extensions/verify/) | Run focused checks after file edits |
| [`working-status`](extensions/working-status/) | Live phase, active file/executable, concurrent tools, and elapsed time |
| [`web-search`](extensions/web-search/) | Web search and page reading |

Each extension's README lists its commands, configuration, dependencies, and limitations.
Job and workflow controls activate when used; context and image-history tools are opt-in.

For automation, use `loop` to repeat a model prompt, `monitor` to run shell checks
and wake the model on matching results, or `schedule` for reminders and cron prompts.
All require an open Pi session; overdue schedules run when the session resumes.

## Everyday controls

Use `/reload` after updating a loaded checkout. Your theme, model and existing
Telegram configuration continue to apply.

| Action | Command |
|---|---|
| Find an extension, prompt or skill command | `Ctrl+Shift+P` or `/palette` |
| Recover a draft replaced by a palette selection | `/palette restore` |
| Check dependencies and plugin configuration | `/doctor` |
| Check Telegram authentication, chat, webhook and topics without sending | `/telegram doctor` |
| Send a Markdown message to this session's configured Telegram destination | `/telegram send **Done** — checks passed` |
| Search the full conversation | `/transcript <search>` |
| Hide/show workflow cards | `/overlay hide` / `/overlay show` |

The footer adds readable local Git counts when relevant: staged, changed, new,
conflicts, and commits ahead/behind the locally known upstream. Its single line
packs context, input/output, cache reads/writes, hit rate
and cost into compact groups; wide terminals add prompt volume and more identity
details. Work separators and final turn receipts both show compact statistics on
one line. The final `Turn` row covers the whole run; `finished` labels its local
completion time. `/turn-stats` opens the full accounting; `/turn-stats full` keeps those
details expanded. The working row names the active file or executable and counts
concurrent tools, using a quiet pulse by default.

The [Gruvbox theme](themes/) uses subdued chrome, readable thinking, and distinct
syntax colors. Code highlighting and filename captions work while streaming and
inside expanded thinking. `markdown.codeBlockIndent: "│ "` adds a slim native code
gutter. Thinking keeps Pi's default label and native visibility toggle.

## Development

Requires Bun 1.3.14. CI uses Node.js 26.8.2 for native PTY fixtures.

```bash
bun install --frozen-lockfile
bun run check
```

Pi APIs are peer dependencies supplied by the host. Shared helpers live in `lib/`.
Package archives contain runtime code, extension READMEs, themes, and the PTY
installation helper; tests and fixtures stay in the checkout.

| Command | Check |
|---|---|
| `bun run check` | TypeScript and the full test suite |
| `bun run check:package` | Pack a temporary archive and load every extension in both orders |
| `bun run check:install` | Install the archive with fresh dependencies and run a native PTY command |
| `bun run check:linux` | Run the suite and archive checks in Docker; add `--clean-install` for a fresh consumer install |
| `bun run preview:ui` | Capture wide/narrow terminal layouts as HTML and text in a temporary directory |

Package checks require Node, npm, Bun, and tar. Clean installs need network access
and Python/C++ build tools when node-pty has no prebuilt binary. The Linux check
requires a running Docker engine and downloads `node:26.8.2-bookworm` plus dependencies.
Temporary installs and containers are removed afterward; Docker images remain cached.

UI previews use synthetic responses in an isolated Pi session with integrations
disabled. They require a working Node.js PTY installation and leave captures in
the reported directory. They check terminal cells, not terminal-app fonts or links.

CI runs the suite and archive checks on macOS and Linux.

## License

MIT
