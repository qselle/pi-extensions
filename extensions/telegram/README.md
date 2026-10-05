# telegram

Provides one optional Telegram service for requested direct messages, monitor alerts, goal notifications, remote questionnaire answers, and a topic for each Pi session. Without valid enabled configuration, it makes no network requests and keeps the `notify_user` tool out of the active model tool list.

## Usage

```text
/telegram setup
/telegram status
/telegram doctor             Check bot, chat, reply polling and topic permissions
/telegram test
/telegram send <Markdown>    Send a message to this session's destination
/telegram on|off
/telegram topic              Show this session's topic state
/telegram topic auto         Use a session topic when supported; otherwise General
/telegram topic required     Require topics instead of falling back to General
/telegram topic off          Send new messages to General
/telegram topic name <text>  Keep a custom topic name
/telegram topic follow       Follow the Pi session name again
/telegram topic retry        Retry discovery or an unconfirmed creation
/telegram topic new          Start a fresh topic on the next outgoing message
```

`/telegram-test` is an alias for `/telegram test`.

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Start a chat with it and obtain the chat ID.
3. Run `/telegram setup` in Pi.

Setup masks the token, validates the values, sends a test message, and saves an owner-only configuration file.

### Direct messages

Use `/telegram send **Build complete** — the report is ready.` to send a message yourself. The `notify_user` tool lets Pi send notifications you request or have already authorized, such as a completion update. The tool accepts a `message` string and always uses your configured recipient and the current session topic. It is active only while Telegram is enabled; setup and on/off update its availability without a reload.

Direct messages support headings, bold, italic, strikethrough, inline and fenced code, links, lists, task lists, and quotes. Tables retain their Markdown columns in a code block. Raw HTML is escaped, terminal controls are removed, and only HTTP, HTTPS and mailto links without embedded credentials become clickable. Images show their alt text rather than uploading or fetching media. Link previews stay disabled.

Messages are validated before any request: Markdown source is limited to 16,384 UTF-16 units and the rendered text to 4,096 UTF-16 units (a conservative Telegram limit). Oversized messages must be shortened; content is never silently truncated or split into multiple notifications. An unconfirmed delivery warns you to check the chat before retrying. Sends are not replayed after failures (only Telegram's explicit rate limits of up to five seconds trigger one bounded retry), so a lost response cannot duplicate a message.

Use `questionnaire` when Pi needs an answer or approval; direct messages do not wait for a reply. Do not include credentials or secrets.

### Monitoring and attention

While Telegram is enabled, an actionable [`monitor`](../monitor/) observation automatically sends one concise update to the session's destination. The card identifies the monitor, check count, wake condition and exit status. It never includes the shell command, captured output or raw provider errors. A failure to start or finish the alert turn sends a separate attention card explaining that monitoring paused.

Silent baselines, unchanged results, cancelled checks, manual pauses/stops and user-interrupted turns produce no extra notification. `--on always` explicitly requests an update after every check. Each alert is deduplicated during the extension's lifetime; delivery is best effort and a failed or unconfirmed send is not automatically replayed. `/telegram off` disables these alerts along with the other Telegram features.

The monitor asks Pi to avoid repeating the automatic status with `notify_user`; it can still send an additional actionable conclusion. Requests for your opinion or approval use the existing delayed questionnaire cards and reply buttons. The default delay remains five minutes, controlled by `questionDelayMinutes`.

Telegram also sends a brief attention card when:

- a goal becomes blocked, stalls, reaches its token budget, or runs out of provider capacity;
- a scheduled task cannot start or finish, its queue cannot be read/saved, or its completion cannot be recorded safely;
- a monitor reaches its run or lifetime limit without another actionable result.

These cards contain status metadata only. Goal objectives, blocker text, scheduled prompts, local paths and raw errors stay in Pi. Goal warnings fire on state changes and coalesce simultaneous budget/capacity changes. Restoring an existing goal warning does not resend it. Completed scheduled turns, successful user pauses/stops and cancelled turns remain quiet; failure to persist a cancellation is still a queue warning because the saved task may otherwise run again. Existing goal-completion notifications remain available.

Every automatic attention event is bound to its source session. Late events from a previous session are dropped, and startup events wait until this session's destination is bound. Delivery uses the existing topic policy and enabled setting.

### Read-only diagnostics

`/telegram doctor` names the configuration file in use (or environment-only configuration), then checks authentication, destination access, webhook conflicts and topic support. For forum groups it also checks the bot's permission to manage topics. It uses the current session's topic policy, including `/telegram topic off` or `required`. An active webhook prevents the reply poller from working even when outgoing messages succeed; diagnostics reports that conflict without changing the webhook or revealing its URL.

Diagnostics sends no messages, creates no topics and consumes no updates. It does not prove message delivery, the existence of a configured fixed topic, or the absence of competing pollers on another machine. Use `/telegram test` when you want an actual delivery test. Diagnostics requires enabled configuration and does not run automatically at startup.

### Session topics

Enable topics for your bot in [@BotFather](https://t.me/BotFather), or use a forum supergroup where the bot can manage topics. The first outgoing message creates the session's topic. Startup and merely viewing status perform no API request. Private chats use the bot's topic capability; groups use the destination's forum setting, following the [Telegram Bot API](https://core.telegram.org/bots/api#createforumtopic).

The topic follows Pi's session name, including `/rename`. Unnamed sessions get a project label plus a short session ID. `/telegram topic name` pins a label; `follow` restores title synchronization. Existing fixed `threadId` configuration takes precedence and is never renamed automatically.

Resuming a session reuses its topic. New sessions and forks receive separate topics, even when a fork inherits its parent's metadata. Mappings belong to the session, bot ID and recipient; token rotation for the same bot preserves them. Pi stores the mapping outside model context, without credentials. Failed name updates keep delivery in the existing topic and appear in topic status.

`auto` falls back to General only when discovery confirms topics are unavailable; General messages receive the session label when it fits Telegram's message limit. `required` refuses that fallback. API failures do not silently move a topic's messages into General. If creation is unconfirmed, check Telegram before using `retry`: the server may have created the topic despite a lost response. The saved unconfirmed state prevents automatic duplicate creation after reload. Use `new` to replace a deleted or unusable topic; it leaves the old topic untouched.

### Replies across concurrent sessions

Local Pi processes using the same bot and agent directory share a single polling lease and a durable reply inbox. A second process reads delivered replies instead of opening a competing Telegram long poll. A stopped poll releases ownership; abandoned leases can be recovered after ten seconds.

Every question remembers its original chat, topic and message ID. Replies, validation hints and completion cards stay there even if another session becomes active or a fresh topic is selected. Topic membership alone never turns a message into a Pi instruction: only an exact pending question can accept an answer.

### Polling failures

While a question waits, reply polling survives laptop sleep, Wi-Fi changes and server hiccups. Network errors, timeouts, local inbox errors, `409` conflicts, `429` rate limits and `5xx` responses are retried with exponential backoff: 1 s, doubling to at most 30 s, reset after a successful poll. A `429` waits at least Telegram's `retry_after`, capped at five minutes. Only `400`, `401`, `403` and `404` stop polling and close the pending cards; the terminal prompt keeps working either way. Answering in the terminal ends any backoff. An active webhook or another poller on the same bot causes repeated `409` retries; `/telegram doctor` reports a webhook.

### Who can answer

Answers can approve actions, so only one Telegram user can give them. In a private chat (positive numeric `chatId`) that is the chat's user. In a group or supergroup, `answerUserId` must name that user; other members' replies are ignored, and their button presses get a short "Only the configured Telegram user can answer" notice. Without `answerUserId`, group answers are ignored and `/telegram doctor` warns. `/telegram setup` asks for it when the chat ID is not a private chat. Bots never count.

## Configuration

`$PI_CODING_AGENT_DIR/telegram.json`:

```json
{
  "botToken": "<token>",
  "chatId": "<chat ID>",
  "topics": "auto",
  "details": "summary",
  "questionDelayMinutes": 5,
  "enabled": true
}
```

`answerUserId` (a positive numeric user ID) is required for answers from a group; see [Who can answer](#who-can-answer). An optional `threadId` selects one existing topic instead of creating per-session topics. `topics` defaults to `auto` and accepts `auto`, `required`, or `off`. Topic commands override this policy for the current session. `details` accepts `minimal`, `summary`, or `full`. Manual edits require `/reload`.

### Legacy configuration files

Without `PI_TELEGRAM_CONFIG_FILE`, the first existing file wins:

1. `telegram.json`
2. `telegram-notify.json` (same fields as `telegram.json`)
3. `telegram-notifications.json`, an older notification format with `botToken`, `chatId`, `delayMinutes`, `enabled` and optional `answerUserId`

The older format maps `delayMinutes` to `questionDelayMinutes` (capped at seven days) and uses `topics: "auto"`. Its unknown fields are ignored. It is checked for ownership, permissions, symlinks and size like `telegram.json`. Legacy files are never rewritten: `/telegram setup`, `on` or `off` saves `telegram.json`, which then takes precedence.

Environment overrides: `PI_TELEGRAM_BOT_TOKEN`, `PI_TELEGRAM_CHAT_ID`, `PI_TELEGRAM_ANSWER_USER_ID`, `PI_TELEGRAM_THREAD_ID`, `PI_TELEGRAM_TOPICS`, `PI_TELEGRAM_GOAL_DETAILS`, `PI_TELEGRAM_QUESTION_DELAY_MINUTES`, and `PI_TELEGRAM_CONFIG_FILE`.

## Dependencies and limitations

- [`questions`](../questions/) sends non-secret questions after the configured delay and accepts replies only from the configured user in the exact chat, topic and question message.
- [`goal`](../goal/) sends one best-effort completion notification.
- [`monitor`](../monitor/) sends actionable result and failure-attention notifications through the `monitor:alert` event.
- [`goal`](../goal/) and [`schedule`](../schedule/) publish metadata-only warnings through `goal:attention` and `schedule:attention`.
- One shared `getUpdates` cursor serves pending questions across local Pi processes. Use one bot per machine, including a separate bot for a Linux VM running alongside macOS. Webhooks and unrelated update consumers still conflict.
- Secret questions send only a redacted notice.
- The owner-only `$PI_CODING_AGENT_DIR/telegram-inbox` buffer stores up to 256 compact replies/callbacks per bot, with a ten-minute delivery window. Expired records are removed on the next poll; files may remain while Pi is stopped. Each record keeps the sender's numeric user ID for answer authorization, but no names. Bot tokens, attachments and unrelated non-reply messages are not stored there. A suspended consumer can miss replies outside that bounded window.

The token is stored in plaintext. Do not commit or share the file. Unix config files must be owned by the current user with mode `0600`; symlinks, non-regular files, broad permissions, and oversized files are rejected. Windows relies on ACLs.

Requested notification text, monitor status metadata, goal text, non-secret questions, and Telegram-entered answers leave the local machine. Delivery is best effort and can be lost on network failure or forced shutdown.

- Uses Pi's public extension API, built-in `fetch`, filesystem APIs, and the Telegram Bot API.
- Runtime dependencies: `proper-lockfile` for shared poll ownership and stale-lease recovery; `marked` for direct-message Markdown parsing.
- Supports macOS, Linux, and Windows with outbound HTTPS access.
- Tests use local fake services on macOS/Linux. Live Telegram delivery and Windows remain unverified.

Formatting and diagnostics use the public [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage), including its [webhook status](https://core.telegram.org/bots/api#getwebhookinfo) and [HTML formatting](https://core.telegram.org/bots/api#html-style) rules.
