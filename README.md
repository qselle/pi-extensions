# pi-extensions

A collection of optional extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Install

```bash
pi install git:github.com/qselle/pi-extensions
pi config
```

The first command installs the package. Use `pi config` to enable only the extensions you want.

## Extensions

| Extension | Purpose |
|---|---|
| [`cat-buddy`](extensions/cat-buddy/) | Animated cat above the input bar |
| [`codex-prompt`](extensions/codex-prompt/) | Flat `›` editor prompt |
| [`context`](extensions/context/) | Context-window breakdown |
| [`file-changes`](extensions/file-changes/) | Current and previous run file changes |
| [`footer`](extensions/footer/) | Model, context, usage, and cost status |
| [`goal`](extensions/goal/) | Persistent goals that continue across turns |
| [`history-search`](extensions/history-search/) | Fuzzy search of the active prompt history |
| [`hyperlinks`](extensions/hyperlinks/) | Clickable terminal paths |
| [`loop`](extensions/loop/) | Repeated prompts on a bounded cadence |
| [`memory`](extensions/memory/) | Explicit project and global memory |
| [`monitor`](extensions/monitor/) | Shell-command monitoring with conditional wakeups |
| [`notify`](extensions/notify/) | Desktop and terminal notifications |
| [`overlay-stack`](extensions/overlay-stack/) | Shared overlay for workflow cards |
| [`plan`](extensions/plan/) | Current multi-step execution plan |
| [`prevent-sleep`](extensions/prevent-sleep/) | Sleep inhibition while Pi works |
| [`questions`](extensions/questions/) | Structured terminal and Telegram questions |
| [`schedule`](extensions/schedule/) | Persistent reminders and cron prompts |
| [`session-search`](extensions/session-search/) | Full-text search across saved sessions |
| [`session-title`](extensions/session-title/) | Automatic session titles |
| [`side-chat`](extensions/side-chat/) | Background side conversations |
| [`subagents`](extensions/subagents/) | Isolated child agents |
| [`telegram`](extensions/telegram/) | Shared Telegram service |
| [`tool-render`](extensions/tool-render/) | Compact built-in tool rendering |
| [`turn-separator`](extensions/turn-separator/) | Timing and usage between tool-work blocks |
| [`verify`](extensions/verify/) | Run focused checks after file edits |

See each extension's README for commands, configuration, and limitations. The differences between `loop`, `monitor`, and `schedule` are covered in the [automation comparison](docs/automation-study.md).

## Development

Requires Bun 1.3.14.

```bash
bun install --frozen-lockfile
bun run check
```

Pi APIs are peer dependencies supplied by the host. `bun run check` runs TypeScript and the full test suite.

## License

MIT
