# telegram

Optional shared Telegram integration for Pi. It provides:

- [`goal`](../goal/) completion notifications
- delayed remote replies for [`questions`](../questions/)
- one central `getUpdates` poller for every Telegram prompt

Without configuration, Telegram starts no network requests, poller, or timer. `goal` and `questions` continue working normally.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and keep its token private.
2. Start a chat with the bot and get your chat ID. For a group, get the group chat ID instead.
3. In Pi, run:

   ```text
   /telegram setup
   ```

Pi asks for the bot token, chat ID, and question delay. The token input is masked and is never added to the conversation or sent to the LLM. Setup validates the values, sends a test message, and writes the token to an owner-only `telegram.json` file.

## Commands

- `/telegram setup` — configure, test, save, and enable Telegram
- `/telegram status` — show whether Telegram is on or off and its question delay
- `/telegram test` — send a test message
- `/telegram on` — enable the saved configuration
- `/telegram off` — disable Telegram without deleting its configuration

`/telegram-test` remains as an alias for `/telegram test`.

## Question behavior

Terminal input starts immediately. Telegram waits five minutes by default. If you answer in Pi before then, no Telegram question is sent. After the first Telegram alert in a questionnaire, its remaining questions are sent immediately.

Question cards:

- use the Pi session title or project directory as their label
- show listed answers as one-button-per-row keyboards
- also accept permitted free text, option numbers, exact option text, and `/cancel`
- race atomically with terminal input; the first valid reply wins
- edit the original message when answered, cancelled, failed, or closed

Secret questions are terminal-only. Telegram receives a redacted notice but never the question text, choices, or answer.

Replies must match the configured chat, optional forum topic, and exact question message. One shared polling cursor serves all pending prompts. A bot using `getUpdates` cannot also use a webhook or another update consumer reliably.

## Goal notifications

A completed persistent goal is sent once with the configured detail level: `minimal`, `summary`, or `full`. Delivery is best effort and is drained during normal shutdown.

## Configuration file

`/telegram setup` writes `~/.pi/agent/telegram.json` by default, or `$PI_CODING_AGENT_DIR/telegram.json` when that directory is configured.

Example:

```json
{
  "botToken": "<BotFather token>",
  "chatId": "<chat ID>",
  "details": "summary",
  "questionDelayMinutes": 5,
  "enabled": true
}
```

Optional fields:

- `threadId` — positive forum-topic ID
- `details` — `minimal`, `summary`, or `full`
- `questionDelayMinutes` — positive delay up to seven days; default `5`
- `enabled` — `false` keeps the configuration but disables Telegram

Manual file changes require `/reload`. The old `telegram-notify.json` filename is still read when `telegram.json` is absent.

Environment values can override file values:

- `PI_TELEGRAM_BOT_TOKEN`
- `PI_TELEGRAM_CHAT_ID`
- `PI_TELEGRAM_THREAD_ID`
- `PI_TELEGRAM_GOAL_DETAILS`
- `PI_TELEGRAM_QUESTION_DELAY_MINUTES`
- `PI_TELEGRAM_CONFIG_FILE`

## Security and limitations

The bot token is a plaintext credential. Do not commit or share it. On Unix, configuration files must be owned by the current user with mode `0600`; symlinks, non-regular files, oversized files, and broader permissions are rejected. Windows relies on ACLs.

Telegram is an external service. Goal summaries, non-secret questions, and Telegram-entered answers leave the local machine. Requests have bounded timeouts and response sizes; errors are sanitized so credentials are not exposed.

Delivery is best effort. Network failures, Telegram outages, crashes, or forced termination can prevent messages.

## Dependencies

- **Runtime:** Pi's public extension API, Bun-compatible `fetch`, and the Telegram Bot API
- **Depends on:** [`goal`](../goal/) only for optional completion events
- **Used by:** [`questions`](../questions/) through the optional shared service
- **Third-party packages:** None
- **Platforms:** macOS, Linux, and Windows; outbound HTTPS is required when enabled
