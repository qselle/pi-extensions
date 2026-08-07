# pi-extensions

A small collection of extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Install

```bash
pi install git:github.com/qselle/pi-extensions
```

Use `pi config` to enable or disable individual extensions.

Each feature is optional and uses Pi's public extension API. Context and persistent state stay explicit, bounded, and inspectable.

## Extensions

| Extension | Description |
|---|---|
| [`cat-buddy`](extensions/cat-buddy/) | Animated cat sitting just above the input bar |
| [`codex-prompt`](extensions/codex-prompt/) | Flat `›` input prompt |
| [`file-changes`](extensions/file-changes/) | Live and last-run file-change summaries |
| [`footer`](extensions/footer/) | Single-line model, context, usage, and cost status |
| [`goal`](extensions/goal/) | Persistent, self-continuing session goals |
| [`history-search`](extensions/history-search/) | Native fuzzy prompt-history search (`Ctrl+R`) |
| [`hyperlinks`](extensions/hyperlinks/) | Clickable file paths |
| [`loop`](extensions/loop/) | Bounded fixed-cadence and model-paced prompt loops |
| [`memory`](extensions/memory/) | Explicit global and project memory |
| [`monitor`](extensions/monitor/) | Deterministic command monitoring with actionable model wakeups |
| [`notify`](extensions/notify/) | Desktop notifications and terminal bell |
| [`overlay-stack`](extensions/overlay-stack/) | Shared workflow-card stack |
| [`plan`](extensions/plan/) | Tactical execution plans |
| [`prevent-sleep`](extensions/prevent-sleep/) | Sleep inhibition while Pi works |
| [`questions`](extensions/questions/) | Terminal and optional Telegram questions |
| [`schedule`](extensions/schedule/) | Persistent one-shot reminders and timezone-aware cron prompts |
| [`session-search`](extensions/session-search/) | Full-text search across saved sessions |
| [`session-title`](extensions/session-title/) | Automatic session titles |
| [`side-chat`](extensions/side-chat/) | Persistent side conversations |
| [`subagents`](extensions/subagents/) | Isolated child agents |
| [`telegram`](extensions/telegram/) | Shared Telegram integration |
| [`tool-render`](extensions/tool-render/) | Compact tool-call rendering |
| [`turn-separator`](extensions/turn-separator/) | Per-turn timing and usage separator |
| [`verify`](extensions/verify/) | Checks project edits immediately |

The design tradeoffs behind `loop`, `monitor`, and `schedule` are captured in the
[automation comparison](docs/automation-study.md).

## Development

Requires Bun 1.3.14. Pi packages are supplied by the host.

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs the TypeScript check and test suite.

## License

MIT
