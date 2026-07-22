# pi-extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Install

```bash
pi install git:github.com/qselle/pi-extensions
```

Use `pi config` to enable or disable individual extensions.

## Extensions

| Extension | Description |
|---|---|
| [`cat-buddy`](extensions/cat-buddy/) | Animated cat sitting on the input bar |
| [`codex-prompt`](extensions/codex-prompt/) | Flat Codex-style `›` input prompt instead of pi's ruled editor box |
| [`file-changes`](extensions/file-changes/) | Live and last-run summaries of files changed by agent tools |
| [`footer`](extensions/footer/) | Single-line Codex-style status bar: model+effort, Ready/Working status, context, and cost |
| [`goal`](extensions/goal/) | Persistent, self-continuing session goals |
| [`history-search`](extensions/history-search/) | Native fuzzy prompt-history search (`Ctrl+R`) |
| [`overlay-stack`](extensions/overlay-stack/) | Persistent top-right workflow cards (`Ctrl+Shift+O`) |
| [`plan`](extensions/plan/) | Tactical execution plans with an independent progress card |
| [`questions`](extensions/questions/) | Claude-style questions with first-reply-wins terminal and optional Telegram input |
| [`side-chat`](extensions/side-chat/) | Persistent, multi-turn side conversations you can spawn, follow up, and navigate during a long-running job |
| [`subagents`](extensions/subagents/) | Persistent isolated child agents for delegated and parallel work |
| [`telegram`](extensions/telegram/) | Optional shared Telegram hub for goals, questions, and future extensions |
| [`tool-render`](extensions/tool-render/) | Codex-style tool blocks: reason-first headline + accent left rail, replacing pi's default card |
| [`turn-separator`](extensions/turn-separator/) | Dim "Worked for <time>" rule between assistant messages that follow tool work |

## Custom keybindings

| Key | Action |
|---|---|
| `Ctrl+R` | Fuzzy-search prompt history |
| `Ctrl+Shift+S` | Open the side-chat workspace |
| `Ctrl+Shift+O` | Show or hide the workflow overlay stack |
| `Ctrl+Shift+C` | Show or hide the input-bar cat |

## Themes

- `gruvbox-dark`

## Development

Requires Bun 1.3.14.

```bash
bun install --frozen-lockfile
bun test
```

## License

MIT
