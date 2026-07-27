# session-title

Names your sessions automatically, and names side chats with the same logic.

`/resume` is useless when every session is an untitled wall of first-prompts. This
gives each one a short, durable name derived from what you actually asked for.

```
before   untitled
after    Clickable file paths
```

## How it works

1. **Instant, free.** The moment you send the first prompt, a local title is
   derived from it — no model call. `can you please fix the retry loop in fetch`
   becomes `fix retry loop fetch`.
2. **Then a real one.** After the turn settles, one bounded request on a cheap
   model replaces it with a proper title.
3. **Rarely again.** Refreshed only every 5 user turns, and the model is told to
   repeat the existing title unless the objective genuinely changed.
4. **Never after you rename.** `/name` or `/title set` stops automatic titling for
   that session for good.

The same policy names side chats: each chat is titled from its own questions after
its first answer.

## Cost and isolation

The titling request contains **only user text** — the first prompt, the most recent
prompts, and the current title. Never assistant output, tool results, diffs, or
reasoning. That keeps it small and keeps content you never wrote out of it.

It runs on its own routing id, so it does not enter the main session's context and
does not disturb its prompt cache. Model selection prefers the cheapest capable
model available and falls back to the session model only if none is found:

| Preference | Input cost |
|---|---|
| `claude-haiku-4-5` | $1.00/Mtok |
| `gpt-4.1-mini`, `gemini-2.5-flash` | ~$0.15–0.40/Mtok |
| `nova-lite`, `nova-micro` | $0.035–0.06/Mtok |

Measured on a real request: 174 input tokens, 4 output tokens, **$0.000194** on
Haiku — about 50x cheaper than the same call on a frontier model, once per 5 turns.

## Commands

| Command | Effect |
|---|---|
| `/title` or `/title status` | Current title, whether automatic titling is on, model, turn accounting, last cost or error |
| `/title now` | Regenerate immediately |
| `/title set <text>` | Set a title by hand and stop automatic titling |
| `/title auto` | Re-enable automatic titling |

## Configuration

Optional `$PI_CODING_AGENT_DIR/session-title.json` (defaults to
`~/.pi/agent/session-title.json`). Shared with side-chat titling:

```json
{
  "enabled": true,
  "model": "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "refreshEvery": 5
}
```

All keys optional. `model` overrides the preference chain; `refreshEvery` sets the
turn gap between refreshes.

## Title rules

At most 5 words and 48 characters. Quotes, markdown, `Title:` prefixes, trailing
punctuation, and extra lines are stripped from the model's answer, and generic
results (`untitled`, `chat`, `session`, `test`) are rejected rather than applied —
so a bad answer leaves the previous title alone instead of degrading it.

## Exports for other extensions

```ts
import { titleConversation } from "../session-title/conversation.ts";
import { requestTitle } from "../session-title/request.ts";
```

`titleConversation` owns the whole policy — refresh interval, prompt assembly,
apply-on-change, and not blocking the next attempt after a failure — so any
conversation-shaped surface can be titled identically. `side-chat` uses it.

## Dependencies

- **Runtime:** Pi's extension API (`setSessionName`, `getSessionName`, `session_info_changed`, `before_agent_start`, `agent_settled`) and `complete()` from `@earendil-works/pi-ai/compat`.
- **Depends on extensions:** None.
- **Used by extensions:** [`side-chat`](../side-chat/).
- **Third-party packages:** None.
- **External services:** the configured or auto-selected titling model.
