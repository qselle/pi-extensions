# telegram-notify

Opt-in Telegram notifications when a persistent [`goal`](../goal/) completes. Notifications are sent only after the goal extension records the final parent-agent token and elapsed-time accounting for the run.

The default summary includes:

- the goal objective
- completed-check progress
- goal-accounted tokens
- elapsed goal work time
- agent-turn count
- the latest progress summary, when present

## Bot setup

1. Open a chat with [@BotFather](https://t.me/BotFather), run `/newbot`, and keep the returned token private.
2. Start a direct conversation with the new bot, or add it to the destination group/channel with permission to post.
3. Obtain the destination chat ID. After sending the bot a message, temporarily export the token and inspect `getUpdates` locally without placing the token itself in the command line:

   ```bash
   read -rsp "Telegram bot token: " PI_TELEGRAM_BOT_TOKEN && echo
   export PI_TELEGRAM_BOT_TOKEN
   node -e 'fetch("https://api.telegram.org/bot" + process.env.PI_TELEGRAM_BOT_TOKEN + "/getUpdates").then(r => r.json()).then(v => console.dir(v, {depth: 8}))'
   ```

   Look for `message.chat.id`. Group and channel IDs are commonly negative. The returned updates can contain private message text, so do not paste the output into public logs.
4. Store the final settings in the dedicated config file below, then run `/reload` if Pi is already open.

## Dedicated config file

The default path follows Pi's agent directory:

```text
$PI_CODING_AGENT_DIR/telegram-notify.json
```

When `PI_CODING_AGENT_DIR` is unset, this is:

```text
~/.pi/agent/telegram-notify.json
```

Create an owner-only file on Unix:

```bash
mkdir -p "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
install -m 600 /dev/null "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/telegram-notify.json"
${EDITOR:-vi} "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/telegram-notify.json"
```

Use this schema:

```json
{
  "botToken": "<token from BotFather>",
  "chatId": "<numeric chat ID or @channel_username>",
  "details": "summary",
  "threadId": 42
}
```

`botToken` and `chatId` are required across the combined file and environment configuration. `threadId` is optional and must be a positive integer. `details` is optional and defaults to `summary`. Unknown fields and invalid value types are rejected so spelling mistakes do not silently disable protection or change the destination.

Set `PI_TELEGRAM_CONFIG_FILE` to use a different file:

```bash
export PI_TELEGRAM_CONFIG_FILE="$HOME/.config/private/pi-telegram.json"
```

Relative paths resolve from Pi's working directory, and `~/` is expanded. An explicitly selected file must exist.

The file is read when the extension loads. After editing or replacing it, run `/reload`; an active extension instance intentionally keeps its validated configuration for that lifecycle.

## Environment variables

Environment variables remain supported for quick tests and per-field overrides. Each non-empty environment value overrides the corresponding file field.

| Variable | File equivalent | Description |
|---|---|---|
| `PI_TELEGRAM_BOT_TOKEN` | `botToken` | Token issued by BotFather |
| `PI_TELEGRAM_CHAT_ID` | `chatId` | Numeric chat ID or `@channel_username` |
| `PI_TELEGRAM_THREAD_ID` | `threadId` | Positive topic ID for a forum-style group |
| `PI_TELEGRAM_GOAL_DETAILS` | `details` | `minimal`, `summary`, or `full` |
| `PI_TELEGRAM_CONFIG_FILE` | — | Override the dedicated config-file path |

For an environment-only quick test when no default config file exists:

```bash
export PI_TELEGRAM_BOT_TOKEN="<token from BotFather>"
export PI_TELEGRAM_CHAT_ID="<numeric chat ID or @channel_username>"
```

Then start Pi or run `/reload`, followed by `/telegram-test`. To avoid storing the token in shell history, use the silent `read` command shown above.

To migrate existing environment-only configuration, copy the values into `telegram-notify.json`, apply `chmod 600`, unset the four Telegram setting variables, and run `/reload`. Keeping selected environment variables is also valid when an intentional override is desired.

Detail levels:

- `minimal` sends only a generic completion heading.
- `summary` adds the objective, progress count, token/time/turn totals, and progress summary.
- `full` also includes every goal check and its final state.

With no default file and no Telegram setting variables, the extension remains quietly disabled. Partial, malformed, unsafe, or explicitly missing configuration produces a local warning without displaying the token.

## Command

```text
/telegram-test
```

This is the only action that sends a test message, and it must be invoked explicitly. It reports sanitized success or failure locally. A test is never sent automatically during startup or configuration validation.

## Delivery and lifecycle

- The goal extension emits a versioned completion event once for a genuine transition to `complete`, normally after `message_end` and `agent_settled` finalize accounting.
- Completion IDs are deduplicated in memory. Restoring an already-completed goal does not replay a notification.
- Each HTTPS request has an eight-second timeout. Only an explicit Telegram `429` with a retry delay of at most five seconds is retried once.
- Timeouts, network failures, and server errors are not retried because Telegram's `sendMessage` API has no idempotency key and an ambiguous retry could duplicate a message.
- Pending requests are tracked and drained during normal session shutdown. Process crashes, forced termination, unavailable networks, and Telegram outages can still prevent delivery; notifications are best effort, not exactly once.
- The notifier is disabled in `PI_SUBAGENT_CHILD` processes so delegated children cannot send unintended goal notifications.

## Privacy and security

Telegram is an external service. Depending on the selected detail level, goal objectives, progress summaries, checks, and usage metadata leave the local machine and are retained according to Telegram and the destination chat's policies. Use `minimal` for sensitive work.

The dedicated file contains a plaintext bot credential. Do not commit, share, or place it inside a project. On Unix, the extension rejects symbolic links, non-regular files, files not owned by the current user, and files readable or writable by group/other users; use `chmod 600`. Windows relies on the file's ACL because POSIX mode checks are unavailable. Config files larger than 64 KiB are rejected.

The extension does not persist the token or chat ID in Pi session entries, and transport errors are replaced with sanitized messages. Telegram requires the bot token in its HTTPS API path internally; the extension never includes that URL in notifications, local errors, test output, or logs.

Reported tokens are the parent goal's accumulated assistant-message usage. They are not provider billing statements and do not include separately accounted subagent usage.

## Dependencies and limitations

- **Runtime:** Pi's extension API, Node filesystem APIs, and a runtime with global `fetch`.
- **Depends on extensions:** [`goal`](../goal/) for completion events.
- **Third-party packages:** None.
- **External service:** Telegram Bot API over HTTPS.
- Bots must have permission to post in the configured destination. Topic notifications require a valid topic ID.
