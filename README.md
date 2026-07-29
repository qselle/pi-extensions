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
| [`hyperlinks`](extensions/hyperlinks/) | Clickable file paths (OSC 8) in tool blocks and change summaries, plus the shared helper other extensions use |
| [`memory`](extensions/memory/) | Explicit local global/project memory with bounded on-demand recall and no automatic transcript learning |
| [`notify`](extensions/notify/) | Terminal-owned desktop notifications (click to focus your window) + bell when the agent finishes, needs input, or a tool fails — only while your tab is unfocused |
| [`prevent-sleep`](extensions/prevent-sleep/) | Keeps the computer awake (`caffeinate` / `systemd-inhibit`) while the agent is working, so long runs and goals don't stall on idle sleep |
| [`overlay-stack`](extensions/overlay-stack/) | Persistent top-right workflow cards (`Ctrl+Shift+O`) |
| [`plan`](extensions/plan/) | Tactical execution plans with an independent progress card |
| [`questions`](extensions/questions/) | Claude-style questions with first-reply-wins terminal and optional Telegram input |
| [`session-title`](extensions/session-title/) | Automatic session names from a cheap model, and the same titling for side chats |
| [`side-chat`](extensions/side-chat/) | Persistent, multi-turn side conversations you can spawn, follow up, and navigate during a long-running job |
| [`subagents`](extensions/subagents/) | Persistent isolated child agents for delegated and parallel work |
| [`telegram`](extensions/telegram/) | Optional shared Telegram hub for goals, questions, and future extensions |
| [`tool-render`](extensions/tool-render/) | Codex-style tool blocks: reason-first headline + accent left rail, replacing pi's default card |
| [`turn-separator`](extensions/turn-separator/) | Dim "Worked for <time>" rule between assistant messages that follow tool work, with that block's tokens, cache hit rate, throughput, and cost |
| [`verify`](extensions/verify/) | Runs your project's check after each edit and appends failures to that tool result, so the agent learns on the same turn |

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
