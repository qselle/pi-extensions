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
| [`file-changes`](extensions/file-changes/) | Live and last-run summaries of files changed by agent tools |
| [`goal`](extensions/goal/) | Persistent, self-continuing session goals |
| [`history-search`](extensions/history-search/) | Native fuzzy prompt-history search (`Ctrl+R`) |
| [`overlay-stack`](extensions/overlay-stack/) | Persistent top-right workflow cards (`Ctrl+Shift+O`) |
| [`plan`](extensions/plan/) | Tactical execution plans with an independent progress card |
| [`subagents`](extensions/subagents/) | Persistent isolated child agents for delegated and parallel work |
| [`telegram-notify`](extensions/telegram-notify/) | Opt-in Telegram summaries when persistent goals complete |

## Custom keybindings

| Key | Action |
|---|---|
| `Ctrl+R` | Fuzzy-search prompt history |
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
