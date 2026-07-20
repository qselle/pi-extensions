# questions

Claude Code-style structured questions for Pi, with terminal and Telegram replies racing safely. The extension registers the `questionnaire` tool and preserves the winning answer in the tool result so it survives compaction.

## Behavior

For every non-secret question, Pi opens a terminal picker immediately and—when the optional Telegram hub is enabled—offers the same question through Telegram after a configurable delay (five minutes by default). The first valid reply wins:

- a terminal answer immediately stops Telegram polling and edits the Telegram card to show completion without copying the answer
- a Telegram answer immediately closes the terminal picker, appears in the terminal result, and updates the original card
- Escape or `/cancel` interrupts the questionnaire and updates the other channel
- a Telegram delivery or polling failure leaves the terminal picker usable
- late delivery races are finalized safely, while shutdown or failed polling closes unresolved cards

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
export PI_TELEGRAM_QUESTION_DELAY_MINUTES="<optional positive first-alert delay; default 5>"
```

Telegram uses compact HTML cards labelled with the Pi session title, or the project directory when no title is set. The first card is delayed by `questionDelayMinutes`/`PI_TELEGRAM_QUESTION_DELAY_MINUTES`; if terminal input wins before the delay, no card is sent. After one card opens, later questions in that questionnaire are delivered immediately.

- Questions with listed options show an inline keyboard with one choice per row.
- Questions without options use Telegram `ForceReply` for free text.
- When freeform answers are allowed, you can ignore the buttons and reply directly with your own text.
- Direct replies can still use an option number such as `2`, the exact option text, or `/cancel`.

For safety, the central poller accepts only:

1. a callback or text reply from the configured chat
2. the configured topic when `threadId` is set
3. a callback on, or direct reply to, the exact Telegram question message
4. a callback index that maps to a current listed choice

Old updates are drained before the first interactive question is sent. Unrelated messages, stale buttons, stale replies, other chats, and other topics cannot win the race. Callback queries are acknowledged, and inline controls are removed as soon as Telegram, the terminal, cancellation, or shutdown closes the question. Resolution edits the original card. Telegram-entered answers remain visible there; terminal-entered answers are not copied to Telegram.

### Telegram Bot API limitations

Telegram reply support uses long polling through `getUpdates`:

- A bot configured with a webhook cannot use `getUpdates`; remove the webhook or use a separate bot.
- `getUpdates` has one shared cursor per bot. Use a dedicated bot if another application also consumes updates, otherwise the consumers can steal updates from each other.
- Bots need permission to read replies in the configured group or topic.
- Telegram delivery and polling are best effort. Network or Telegram failures do not prevent terminal answers.

In non-interactive Pi modes, Telegram can be the only reply channel for non-secret questions. Without TUI or valid Telegram configuration—or for a secret question outside TUI—the tool returns a clear interruption instead of waiting forever.

## Secret questions

Set `secret: true` to mask terminal input and omit the value from Pi's transcript. Pi stores only `[secret provided]`.

Secret questions are terminal-only. If Telegram is enabled, it receives a passive redacted card saying that secure input is waiting; the question text, choices, and answer are never sent, and no Telegram polling starts for that card. Completion edits the card to `Answered securely in Pi` without exposing the value.

## Configuration lifecycle

The central Telegram extension validates configuration and registers its service when enabled. Run `/reload` after changing the config file or enabling/disabling Telegram. Missing service registration silently leaves this extension terminal-only; invalid Telegram configuration produces a sanitized warning from the hub without breaking questions.

This extension ignores the Telegram service in `PI_SUBAGENT_CHILD` processes so child agents cannot independently solicit remote replies.

## Dependencies and limitations

- **Runtime:** Pi's public extension and TUI APIs.
- **Optional integration:** [`telegram`](../telegram/) adds delayed remote questions when enabled; terminal questions do not depend on it.
- **Third-party packages:** None.
- **Platforms:** Terminal interaction is cross-platform. Telegram requires outbound HTTPS access.
- **Limits:** Four questions per call, eight listed options per question, and 4,000 characters per freeform answer.
