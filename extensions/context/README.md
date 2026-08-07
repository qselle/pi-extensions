# context

See where the context window actually goes.

`/context` reports the three regions of a request separately, because they are
billed from different places — and a single "system prompt" figure hides the
most actionable part:

```
◆ Context 28.2K est · 27.9K reported · 11% of 258K · compaction at 242K
system prompt            6.1K
  pi base prompt         3.2K
  guidelines             1.9K 12 bullets
  AGENTS.md              1.0K
tool schemas             3.4K
  subagents               890
  memory                  640
  update_goal             520
  … +5 more               1.4K
conversation            18.7K
  tool results          14.8K 12 entries
  context: goal-context    850 3 entries
  user messages          1.9K 14 entries
largest entries
  tool results           8.1K bash
```

## Commands

- `/context` — append a context report to the transcript

## What is measured

| Region | Source | Why it is separate |
|---|---|---|
| **system prompt** | `ctx.getSystemPrompt()`, itemized with `ctx.getSystemPromptOptions()` | The prompt string: pi's base prompt, guidelines, tool snippets, `AGENTS.md`-style context files, skills, appended and custom prompts |
| **tool schemas** | `pi.getAllTools()` filtered by `pi.getActiveTools()` | Schemas travel in the request's tool array, *not* inside the prompt text. Inactive registered tools cost nothing and are excluded |
| **conversation** | `sessionManager.buildContextEntries()` | Only the entries that survived compaction, grouped by kind |

Within the system prompt, the total is the measured prompt rather than the sum of
the parts, so anything not attributable is reported as `pi base prompt` instead
of quietly disappearing.

Conversation entries are grouped per kind, and **custom context messages are
itemized by `customType`** — that is what makes each extension's own injection
visible as its own line (`context: goal-context`, `context: plan-context`, …)
rather than one opaque "custom" bucket. Buckets are sorted by weight, and a
section longer than six rows summarises its tail as `… +N more`.

## Accuracy

The headline `Used A / B (C%)` is **pi's own figure** — `calculateContextTokens` over
the last response — because that is what compaction actually reacts to. The table
below it is an independent estimate, so the two are reconciled explicitly in the
footer rather than competing in the header:

- `estimated total` — the sum of the table, using the same chars/4 heuristic as
  pi's `estimateTokens` (which counts text, thinking, and tool-call arguments).
- `provider last turn` — pi's figure, annotated with the provider's own
  components (`fresh + cached prompt · output`). A large gap between the two is
  normally cache accounting, and naming the parts is more useful than asserting
  which side is right.
- `compacts at` is the model window minus pi's
  `DEFAULT_COMPACTION_SETTINGS.reserveTokens`.
- Per-row shares are of the estimated total, since that is what the rows sum to.
- Every accessor is read defensively: a host that omits or throws from
  `getSystemPrompt`, `getSystemPromptOptions`, `getContextUsage`, or
  `buildContextEntries` yields an empty report instead of an error.

## Privacy

Context files and skills are **measured, never stored**. The persisted entry holds
only labels and token counts, so file contents never reach the session file. Labels
come from untrusted places (paths, tool names, `customType`s) and are flattened to
a single line before being persisted or drawn.

The report is a custom entry, not a message: it renders in the transcript and
never enters the conversation it is measuring. Outside TUI mode the same report is
delivered through `ctx.ui.notify` as plain text.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`registerCommand`, `registerEntryRenderer`, `appendEntry`, `getAllTools`, `getActiveTools`, `getSystemPrompt`, `getSystemPromptOptions`, `getContextUsage`, `sessionManager.buildContextEntries`, `estimateTokens`, `DEFAULT_COMPACTION_SETTINGS`).
- **Depends on extensions:** [`footer`](../footer/) — reuses its `formatTokens`/`formatPercent` helpers so both surfaces spell numbers identically.
- **Used by extensions:** None.
- **Third-party packages:** None.
- **Platforms:** Cross-platform. The table renders in TUI mode; other modes get the same report as notified plain text.
