# side-chat

Persistent, multi-turn **side conversations** that run in the background while
the main agent keeps working on a long-running job. Spawn one with a single
question, follow up later, and navigate the history of every side chat — all
without polluting the main context.

Where the main transcript is your primary task, a side chat is a separate
thread for thinking out loud, asking questions, or exploring an idea. Each chat
has its own history and is **named after its first question** (like the session
list in `/resume`); you can run several at once, switch between them, and
promote a useful answer back into the main session when you want it.

```
/side why would this migration deadlock under load?
  → “why would this migration deadlock under load?” is generating in the
    background. Open it with /side or Ctrl+Shift+S.

# …keep working. Later, open the workspace to read and follow up:
/side
  ● why would this migration deadlock under load? · openai/gpt-5 · idle
  ─────────────────────────────────────────────────────────────────────
  › you
    why would this migration deadlock under load?
  ● openai/gpt-5
    Two transactions take the same two row locks in opposite order …
  › ▌
  ⏎ send · PgUp/PgDn scroll · Ctrl+O promote · Esc back · 100%
```

## Why this is different

This raises the bar over a one-shot `/side` question:

- **Background** — `/side <question>` is fire-and-forget: it never takes over
  the screen. Generation runs in the background with an independent abort per
  chat, so a side chat never touches the main agent turn.
- **Named automatically** — a chat is titled from its first question, so the
  workspace and overlay list read like a history you can scan.
- **Multi-turn** — every side chat is a real conversation you can follow up in.
- **Multiple chats** — spawn as many as you like and switch between them.
- **Navigable history** — a workspace lists every chat; open one to read and
  scroll its full transcript.
- **Works during a long job** — `/side` and the `Ctrl+Shift+S` shortcut work
  even while the main agent is streaming.
- **Persistent** — chats survive `/reload` and are restored per branch after
  `/tree` navigation.
- **Promote** — lift a side answer into the main conversation only when useful
  (guarded so the same answer is never promoted twice).

## Commands and keys

| Entry point | Behavior |
|---|---|
| `/side <question>` | Start a background side chat named after the question; a notification confirms it |
| `/side` | Open the workspace to browse, read, and follow up |
| `Ctrl+Shift+S` | Open the side-chat workspace |

**List view:** `↑↓` select · `⏎`/`→` open · `n` new · `d` `d` delete · `Esc`/`q` close.

**Chat view:** type to compose · `⏎` send · `Esc` back to the list ·
`PgUp`/`PgDn` scroll · `Home`/`End` jump/follow · `Ctrl+O` promote the latest
answer · `Ctrl+R` retry after an error · `Ctrl+X` stop the current generation.

While any chat is generating, a card appears in the shared top-right workflow
overlay (from the `overlay-stack` extension), and aggregate side-chat usage
shows as a compact footer status such as `side ↑12k ↓850 R20k $0.0421` — so a
backgrounded chat stays visible without opening the workspace.

## Context modes

At creation a side chat freezes a system-prompt preamble:

- `snapshot` (default) — a bounded head+tail snapshot of the current main
  conversation is embedded as **read-only reference material**, then trimmed to
  fit the chat model's context window.
- `none` — no main-conversation context, just the repo/project instructions.

A strong boundary keeps the side thread read-only: no tools, no file or system
changes, and the main task is never continued. Only the current project/safety
instructions remain authoritative.

## Model and persistence

- Each chat is pinned to the model that was active when it was created and keeps
  that model for every follow-up. Answers run at `reasoning: "low"`, capped at
  4096 output tokens.
- Promoted answers render inline in the main transcript as `• Promoted side
  answer` and are delivered on the next main turn.
- Chats are stored as non-context custom session entries: one immutable metadata
  entry per chat plus a compact state entry on each change (last write wins,
  deletions are tombstoned). On `session_start` and `/tree` navigation the store
  is rebuilt from the active branch, and any interrupted generation is
  normalized back to idle.

## Dependencies and limitations

- **Runtime:** Pi's public extension, session, model, and TUI APIs, plus
  `complete()` from `@earendil-works/pi-ai/compat`.
- **Depends on extensions:** `overlay-stack` (for the live workflow card).
- **Third-party packages:** none; Pi-provided packages are supplied by the host.
- **External services:** the configured model provider used by each chat.
- **Interactive only:** the workspace requires the TUI; `/side` reports a notice
  in non-interactive modes.
- **Non-streaming:** answers are delivered when complete rather than token by
  token; the overlay card and `thinking…` indicator show progress.
