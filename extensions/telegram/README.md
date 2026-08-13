# telegram

Provides one optional Telegram Bot API service for goal notifications and remote questionnaire answers.

Without valid enabled configuration, it makes no network requests and other extensions continue without Telegram.

## Usage

```text
/telegram setup
/telegram status
/telegram test
/telegram on|off
```

`/telegram-test` is an alias for `/telegram test`.

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Start a chat with it and obtain the chat ID.
3. Run `/telegram setup` in Pi.

Setup masks the token, validates the values, sends a test message, and saves an owner-only configuration file.

## Configuration

`$PI_CODING_AGENT_DIR/telegram.json`:

```json
{
  "botToken": "<token>",
  "chatId": "<chat ID>",
  "threadId": 123,
  "details": "summary",
  "questionDelayMinutes": 5,
  "enabled": true
}
```

`threadId` is optional. `details` accepts `minimal`, `summary`, or `full`. Manual edits require `/reload`. The legacy `telegram-notify.json` file is read only when `telegram.json` is absent.

Environment overrides: `PI_TELEGRAM_BOT_TOKEN`, `PI_TELEGRAM_CHAT_ID`, `PI_TELEGRAM_THREAD_ID`, `PI_TELEGRAM_GOAL_DETAILS`, `PI_TELEGRAM_QUESTION_DELAY_MINUTES`, and `PI_TELEGRAM_CONFIG_FILE`.

## Dependencies and limitations

- [`questions`](../questions/) sends non-secret questions after the configured delay and accepts replies only from the configured chat, optional topic, and exact question message.
- [`goal`](../goal/) sends one best-effort completion notification.
- One shared `getUpdates` cursor serves all pending questions. Do not use the same bot with a webhook or another update consumer.
- Secret questions send only a redacted notice.

The token is stored in plaintext. Do not commit or share the file. Unix config files must be owned by the current user with mode `0600`; symlinks, non-regular files, broad permissions, and oversized files are rejected. Windows relies on ACLs.

Goal text, non-secret questions, and Telegram-entered answers leave the local machine. Delivery is best effort and can be lost on network failure or forced shutdown.

- Uses Pi's public extension API, built-in `fetch`, and the Telegram Bot API.
- Optionally consumes [`goal`](../goal/) events and provides a service to [`questions`](../questions/).
- No third-party packages.
- Supports macOS, Linux, and Windows with outbound HTTPS access.
