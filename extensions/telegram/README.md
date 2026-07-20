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
- session shutdown aborts polling, marks pending and passive cards closed, and drains tracked delivery
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
  "details": "summary",
  "questionDelayMinutes": 5
}
```

- `botToken` and `chatId` are required across file and environment settings.
- `threadId` is optional and targets a forum topic.
- `details` controls goal-completion messages: `minimal`, `summary`, or `full`.
- `questionDelayMinutes` controls how long Pi waits before sending the first Telegram question card from each questionnaire call. It defaults to `5` and accepts positive fractional minutes up to `10080`.
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
| `PI_TELEGRAM_QUESTION_DELAY_MINUTES` | `questionDelayMinutes` | Positive delay before the first question card; default `5` |
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

When `questions` finds the registered service, terminal input starts immediately and Telegram waits for `questionDelayMinutes` (five minutes by default). If the terminal resolves during that delay, no Telegram card is sent. Once the first card is delivered, follow-up questions in the same questionnaire are sent immediately. The first valid reply still wins.

- Cards use Telegram HTML, identify the Pi session title (or project directory), and show question progress and clearer wait-duration copy.
- Listed choices use a one-button-per-row inline keyboard; free-text prompts use `ForceReply`.
- Telegram wins: the terminal picker closes and its answer appears in the terminal tool result.
- Terminal wins: Telegram polling closes and the original card is edited to its resolved state without copying the terminal answer into Telegram.
- Telegram answers, terminal/Telegram cancellation, and secret completion all edit the original card instead of adding completion replies.
- A card that finishes sending after terminal input already won is immediately finalized rather than left pending.
- Polling failure or shutdown marks unresolved cards closed and removes their controls.
- Direct text replies remain available for freeform answers, numbered/exact choices, and `/cancel`.
- A secret question sends only a redacted passive alert and must be answered in the terminal; it never starts Telegram polling or exposes the prompt, options, or answer.

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

Telegram is an external service. Goal summaries, non-secret questions, and answers entered through Telegram leave the local machine and are retained under Telegram's policies.

The config contains a plaintext credential. Do not commit or share it. On Unix, the loader rejects symlinks, non-regular files, foreign ownership, group/other permissions, and files over 64 KiB. Windows relies on ACLs. Errors and tool results never expose the token or token-bearing request URL.

A question marked `secret` is masked and omitted from Pi's transcript. Telegram receives only a redacted notification that secret input is waiting; the prompt text, options, and answer remain terminal-only.

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
