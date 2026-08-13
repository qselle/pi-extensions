# questions

Registers a `questionnaire` tool for structured terminal questions with optional Telegram replies.

## Usage

```json
{
  "questions": [
    {
      "id": "scope",
      "question": "Which scope should I use?",
      "options": ["Minimal", "Complete"]
    }
  ]
}
```

A call accepts one to four questions, up to eight options per question, and unique IDs. `Other` is added by default; set `allow_other: false` to restrict answers to listed options. Questions without options use freeform input.

Terminal controls:

- Up/Down changes selection.
- Enter confirms.
- `1`–`9` select an option directly.
- Escape leaves freeform input or cancels the question.

Questions run in order and replace the editor while active. The answer is stored in the tool result.

Telegram:

When [`telegram`](../telegram/) is configured, non-secret questions are sent after its configured delay. Terminal and Telegram answers race; the first valid answer wins and closes the other channel. Telegram failures do not disable terminal input.

Replies must come from the configured chat, optional topic, and exact question message. A bot used for replies cannot also use a webhook or another `getUpdates` consumer reliably.

Secret answers:

Set `secret: true` for masked terminal input. The tool result receives an opaque handle instead of the value. A later tool call can use that handle; the extension substitutes the value in memory before execution.

Secret values are never persisted and handles expire on shutdown or branch change. Stale handles block the tool call. Tool output can still reveal a substituted value, so use commands that do not echo secrets. Secret questions are terminal-only; Telegram receives only a redacted notice.

## Dependencies and limitations

- Uses Pi's public extension, tool, editor, and TUI APIs.
- Optionally uses [`telegram`](../telegram/); no third-party packages.
- Terminal interaction is cross-platform. Telegram requires outbound HTTPS.
- Freeform answers are limited to 4,000 characters.
- Without a TUI or configured Telegram service, non-secret questions return an interruption instead of waiting. Secret questions always require the TUI.
