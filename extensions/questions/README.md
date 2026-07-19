# questions

Claude Code-style structured questions for Pi, with terminal and Telegram replies racing safely. The extension registers the `questionnaire` tool and preserves the winning answer in the tool result so it survives compaction.

## Behavior

For every question, Pi opens a terminal picker and—when the optional Telegram hub is enabled—sends the same question to Telegram. Both remain visible at the same time and the first valid reply wins:

- a terminal answer immediately stops Telegram polling and is mirrored to Telegram
- a Telegram answer immediately closes the terminal picker and appears in the terminal result
- Escape or `/cancel` interrupts the questionnaire and is mirrored to the other channel
- a Telegram delivery or polling failure leaves the terminal picker usable

Questions run sequentially. The picker shows numbered options in a bordered Claude-style panel. `Other` is the final choice by default and opens a freeform input; set `allow_other: false` to restrict a question to its listed options. Questions without options always use freeform input.

Example tool input:

```json
{
  "questions": [
    {
      "id": "scope",
      "question": "Which implementation scope should I use?",
      "options": ["Minimal", "Complete"]
    },
    {
      "id": "notes",
      "question": "Anything else I should account for?"
    }
  ]
}
```

A call supports one to four questions, with up to eight options each. IDs must be unique within the call.

## Terminal interaction

The active question replaces the editor temporarily:

- Up/Down changes the selection.
- Enter selects an option.
- `1` through `9` select directly.
- Selecting the final `Other` row opens freeform input.
- Escape leaves freeform input or cancels the question.

The terminal title changes to `❓ Input needed` while a question is pending. The normal title is restored after the questionnaire ends.

## Telegram replies

The extension optionally acquires the shared service documented by [`telegram`](../telegram/README.md). It never loads credentials, starts polling, or performs Telegram requests itself. Configure the owner-only `telegram.json` file (the old `telegram-notify.json` name is still detected) or these environment variables:

```bash
export PI_TELEGRAM_BOT_TOKEN="<token from BotFather>"
export PI_TELEGRAM_CHAT_ID="<numeric chat ID or @username>"
export PI_TELEGRAM_THREAD_ID="<optional forum topic ID>"
```

Each Telegram question uses `force_reply`. Reply directly to that bot message with:

- an option number such as `2`
- the exact option text
- any other text when freeform answers are allowed
- `/cancel` to interrupt the questionnaire

For safety, the poller accepts only a text message that:

1. comes from the configured chat
2. comes from the configured topic when `threadId` is set
3. directly replies to the exact Telegram question message

Old updates are drained before the first question is sent. Unrelated messages, stale replies, other chats, and other topics cannot win the race. The winning non-secret answer is displayed in both channels; secret answers are mirrored only as `[secret provided]`.

### Telegram Bot API limitations

Telegram reply support uses long polling through `getUpdates`:

- A bot configured with a webhook cannot use `getUpdates`; remove the webhook or use a separate bot.
- `getUpdates` has one shared cursor per bot. Use a dedicated bot if another application also consumes updates, otherwise the consumers can steal updates from each other.
- Bots need permission to read replies in the configured group or topic.
- Telegram delivery and polling are best effort. Network or Telegram failures do not prevent terminal answers.

In non-interactive Pi modes, Telegram can be the only reply channel. Without TUI or valid Telegram configuration, the tool returns a clear interruption instead of waiting forever.

## Secret questions

Set `secret: true` to mask terminal input and omit the value from Pi's transcript. Pi stores only `[secret provided]`.

A secret sent through Telegram is still visible to and retained by Telegram. The bot includes this warning in the question. Use the terminal for secrets when Telegram retention is unacceptable.

## Configuration lifecycle

The central Telegram extension validates configuration and registers its service when enabled. Run `/reload` after changing the config file or enabling/disabling Telegram. Missing service registration silently leaves this extension terminal-only; invalid Telegram configuration produces a sanitized warning from the hub without breaking questions.

This extension ignores the Telegram service in `PI_SUBAGENT_CHILD` processes so child agents cannot independently solicit remote replies.

## Dependencies and limitations

- **Runtime:** Pi's public extension and TUI APIs.
- **Optional integration:** [`telegram`](../telegram/) adds simultaneous remote questions when enabled; terminal questions do not depend on it.
- **Third-party packages:** None.
- **Platforms:** Terminal interaction is cross-platform. Telegram requires outbound HTTPS access.
- **Limits:** Four questions per call, eight listed options per question, and 4,000 characters per freeform answer.
