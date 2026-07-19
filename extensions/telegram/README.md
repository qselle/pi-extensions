# telegram

Optional shared Telegram infrastructure for Pi extensions. This extension owns Telegram configuration, Bot API transport, one long-polling cursor, pending reply routing, and lifecycle cleanup.

When enabled, it currently provides:

- persistent [`goal`](../goal/) completion notifications
- remote replies for [`questions`](../questions/), raced against the terminal
- `/telegram-test` for explicit configuration testing

`goal` and `questions` remain fully functional without Telegram. With no configuration—or when this extension is disabled—no Telegram service is registered, no network requests are made, and no polling loop or timer is started.

## Architecture

`telegram` is the single Telegram owner, analogous to the shared [`overlay-stack`](../overlay-stack/) compositor:

- credentials and destination are loaded and validated once
- all consumers use one versioned global service registry
- all interactive prompts share one `getUpdates` cursor and polling loop
- replies are routed by exact Telegram question message ID
- session shutdown aborts polling, resolves pending prompts, and drains tracked delivery
- `PI_SUBAGENT_CHILD` processes never register the service

Goal completion formatting remains an adapter inside this extension. The goal extension only emits `GOAL_COMPLETED_EVENT`; it has no Telegram or network dependency.

## Bot setup

1. Open a chat with [@BotFather](https://t.me/BotFather), run `/newbot`, and keep the token private.
2. Start a direct conversation with the bot, or add it to the destination group with permission to post and read replies.
3. Send the bot a message, then inspect `getUpdates` locally without putting the token in the command line:

   ```bash
   read -rsp "Telegram bot token: " PI_TELEGRAM_BOT_TOKEN && echo
   export PI_TELEGRAM_BOT_TOKEN
   bun -e 'fetch("https://api.telegram.org/bot" + process.env.PI_TELEGRAM_BOT_TOKEN + "/getUpdates").then(r => r.json()).then(v => console.dir(v, {depth: 8}))'
   ```

   Use `message.chat.id`. Forum topics additionally use `message.message_thread_id`. The response can contain private messages; do not publish it.
4. Create the secure configuration below and run `/reload`.

## Configuration file

The preferred path follows Pi's agent directory:

```text
$PI_CODING_AGENT_DIR/telegram.json
```

When `PI_CODING_AGENT_DIR` is unset:

```text
~/.pi/agent/telegram.json
```

Create an owner-only file on Unix:

```bash
mkdir -p "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
install -m 600 /dev/null "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/telegram.json"
${EDITOR:-vi} "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/telegram.json"
```

Schema:

```json
{
  "botToken": "<token from BotFather>",
  "chatId": "<numeric chat ID or @chat_username>",
  "threadId": 42,
  "details": "summary"
}
```

- `botToken` and `chatId` are required across file and environment settings.
- `threadId` is optional and targets a forum topic.
- `details` controls goal-completion messages: `minimal`, `summary`, or `full`.
- Unknown fields and invalid types are rejected.

For backward compatibility, if `telegram.json` does not exist, the extension automatically checks the old `telegram-notify.json` filename in the same directory. Explicit `PI_TELEGRAM_CONFIG_FILE` paths never fall back.

The file is loaded once per extension lifecycle. Run `/reload` after editing it.

## Environment variables

Non-empty environment values override matching file values.

| Variable | File equivalent | Description |
|---|---|---|
| `PI_TELEGRAM_BOT_TOKEN` | `botToken` | BotFather token |
| `PI_TELEGRAM_CHAT_ID` | `chatId` | Numeric chat ID or `@chat_username` |
| `PI_TELEGRAM_THREAD_ID` | `threadId` | Positive forum topic ID |
| `PI_TELEGRAM_GOAL_DETAILS` | `details` | `minimal`, `summary`, or `full` |
| `PI_TELEGRAM_CONFIG_FILE` | — | Explicit config path |

With no default file, environment-only setup is supported:

```bash
export PI_TELEGRAM_BOT_TOKEN="<token>"
export PI_TELEGRAM_CHAT_ID="<chat ID>"
```

## Goal notifications

A genuine goal transition to `complete` emits a versioned event after final accounting. The Telegram adapter:

- deduplicates completion IDs in memory
- formats the selected detail level
- sends only after final parent token/time accounting
- tracks delivery through normal session shutdown
- never changes goal behavior when Telegram is unavailable

## Question replies

When `questions` finds the registered service, each question appears simultaneously in the terminal and Telegram. The first valid reply wins.

- Listed choices use a one-button-per-row inline keyboard; free-text prompts use `ForceReply`.
- Telegram wins: the terminal picker closes and its answer appears in the terminal tool result.
- Terminal wins: Telegram polling closes, the keyboard is removed, and the terminal answer is mirrored under the Telegram question.
- Direct text replies remain available for freeform answers, numbered/exact choices, and `/cancel`.
- Cancellation is mirrored to the other channel.
- Secret answers and callback notices are represented only as `[secret provided]`; the raw value is never mirrored or stored in Pi.

The service accepts only callbacks or text replies from the configured chat/topic and routes them by the exact Telegram question message. Callback indexes are mapped to the current typed choices rather than trusting answer text from Telegram. Callback queries are acknowledged, and stale or resolved keyboards are cleared. Stale and unrelated updates cannot answer a question.

### Long-polling constraints

Telegram interactive replies use `getUpdates`:

- Webhooks and `getUpdates` cannot be active for the same bot.
- Telegram exposes one update cursor per bot. Use a dedicated bot if another application consumes updates.
- One central poller serves every Pi extension and concurrent pending prompt, including both `message` and `callback_query` updates.
- Polling starts only while at least one prompt is pending and stops when none remain.

## Command

```text
/telegram-test
```

This explicitly sends one test message. Nothing is sent automatically during startup or validation.

## Security and privacy

Telegram is an external service. Goal summaries, questions, and non-secret answers sent through it leave the local machine and are retained under Telegram's policies.

The config contains a plaintext credential. Do not commit or share it. On Unix, the loader rejects symlinks, non-regular files, foreign ownership, group/other permissions, and files over 64 KiB. Windows relies on ACLs. Errors and tool results never expose the token or token-bearing request URL.

A question marked `secret` is masked and omitted from Pi's transcript, but a secret entered in Telegram is still retained by Telegram. Prefer terminal input when that retention is unacceptable.

## Delivery guarantees

- Requests have bounded timeouts and bounded response bodies.
- Only an explicit short Telegram `429 retry_after` is retried once for messages.
- Ambiguous network/server failures are not retried automatically to avoid duplicate messages.
- Delivery is best effort; crashes, force termination, network outages, or Telegram outages can prevent it.

## Dependencies and limitations

- **Runtime:** Pi's public extension API, Bun-compatible `fetch`, and Telegram Bot API.
- **Depends on extensions:** [`goal`](../goal/) only for optional completion events.
- **Used by extensions:** [`questions`](../questions/) acquires the service optionally at execution time.
- **Third-party packages:** None.
- **Platforms:** macOS, Linux, and Windows; outbound HTTPS is required only when enabled.
