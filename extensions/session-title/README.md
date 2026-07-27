# session-title

Names a session once, then leaves it alone.

`/resume` is useless when every session is an untitled wall of first-prompts.

```
before   untitled
after    Clickable file paths
```

## How it works

1. **Instant, free.** On your first prompt a title is derived locally — no model
   call. `can you please fix the retry loop in fetch` becomes `fix retry loop fetch`.
2. **Then a real one.** After the turn settles, one bounded request on a cheap
   model replaces it.
3. **Then never again.** A session with a name is not touched, so `/name` is safe
   by construction and no title can drift or churn. `/title now` forces a redo.

Side chats work the same way: the first question names the chat, the first answer
replaces it with a generated title.

Resuming or `/reload` recovers your prompts from the session, so titling still
works and `/title now` is available immediately.

## Cost

The request holds **only user text** — the first substantive request plus the last
few — never assistant output, tool results, diffs, or reasoning. It runs on its own
routing id, so it never enters the main session's context or its prompt cache.

Measured: 174 in / 4 out, **$0.000194** on Haiku, once per session.

Model selection prefers the cheapest capable model available (`claude-haiku-4-5`,
`gpt-4.1-mini`, `gemini-2.5-flash`, `nova-lite`, `nova-micro`) and falls back to the
session model only if none is found.

## Commands

| Command | Effect |
|---|---|
| `/title` | Current title, state, model, tracked prompts, last cost or error |
| `/title now` | Generate a title now, even if the session already has one |
| `/title set <text>` | Name it yourself |

## Configuration

Optional `$PI_CODING_AGENT_DIR/session-title.json`, shared with side-chat titling:

```json
{ "enabled": true, "model": "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0" }
```

## Title rules

At most 5 words and 48 characters. Quotes, markdown, `Title:` prefixes, trailing
punctuation, and extra lines are stripped, and generic answers (`untitled`, `chat`,
`hello`) are rejected — so a bad answer leaves the current name alone and the next
settled turn tries again.

A leading greeting is skipped when choosing the anchor request, since sessions that
open with "hello" would otherwise be named from it. No existing title is ever sent
to the model, so a bad title cannot perpetuate itself.

## Dependencies

- **Runtime:** Pi's extension API (`setSessionName`, `getSessionName`, `before_agent_start`, `agent_settled`) and `complete()` from `@earendil-works/pi-ai/compat`.
- **Depends on extensions:** None.
- **Used by extensions:** [`side-chat`](../side-chat/).
- **Third-party packages:** None.
- **External services:** the configured or auto-selected titling model.
