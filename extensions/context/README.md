# context

See where the context window actually goes.

`/context` reports the three regions of a request separately, because they are
billed from different places — and a single "system prompt" figure hides the
most actionable part:

```
◆ Context  Used 27,900 / 258,000 (11%)
conversation                 18,700  66%
  tool results               14,800  52%  12 entries
  context: goal-context         850   3%  3 entries
system prompt                 6,100  22%
  pi base prompt              3,200  11%
  guidelines                  1,900   7%  12 bullets
  AGENTS.md                    1,000   4%
tool schemas                  3,400  12%
  subagents                     890   3%
largest entries
  tool results                8,100       bash #391
estimated total              28,200
pi context total             27,900       last turn: 15,110 fresh + 6,390 cached · 6,400 out
```

## Commands

- `/context` — append a context report to the transcript
- Pi's expand shortcut (`Ctrl+O` by default) — toggle between the compact view
  and every measured row

## What is measured

| Region | Source | Why it is separate |
|---|---|---|
| **system prompt** | `ctx.getSystemPrompt()`, itemized with `ctx.getSystemPromptOptions()` | The prompt string: pi's base prompt, guidelines, tool snippets, `AGENTS.md`-style context files, skill descriptors, appended and custom prompts |
| **tool schemas** | `pi.getAllTools()` filtered by `pi.getActiveTools()` | Schemas travel in the request's tool array, *not* inside the prompt text. Inactive registered tools cost nothing and are excluded |
| **conversation** | `sessionManager.buildContextEntries()` | Only the entries that survived compaction, grouped by kind |

Within the system prompt, the total is the measured prompt rather than the sum of
the parts, so anything not attributable is reported as `pi base prompt` instead
of quietly disappearing.

Conversation entries are grouped per kind, and **custom context messages are
itemized by `customType`** — that is what makes each extension's own injection
visible as its own line (`context: goal-context`, `context: plan-context`, …)
rather than one opaque "custom" bucket. Buckets are sorted by weight, and a
section longer than six rows summarises its tail as `… +N more`; Pi's existing
expand shortcut reveals the full section. Assistant entries are split into
reasoning, answers, and tool-call arguments while still reconciling exactly to
Pi's per-message estimate. Shell executions explicitly excluded from model
context are ignored.

## Accuracy

The headline `Used A / B (C%)` is **Pi's own `getContextUsage()` figure** because
that is what its compaction logic reacts to. The table below it is an independent
estimate, so the two are reconciled explicitly in the footer rather than
competing in the header:

- `estimated total` — the sum of the table, using the same chars/4 heuristic as
  pi's `estimateTokens` (which counts text, thinking, and tool-call arguments).
- `pi context total` — the same authoritative figure, annotated with the last
  provider response's components (`fresh + cached prompt · output`). A large gap
  against the estimate is normally cache accounting, and naming the parts is
  more useful than asserting which side is right.
- Per-row shares are of the estimated total, since that is what the rows sum to.
- Every accessor is read defensively: a host that omits or throws from
  `getSystemPrompt`, `getSystemPromptOptions`, `getContextUsage`, or
  `buildContextEntries` yields a partial report instead of an error.

## Privacy

Context files and skill descriptors are **measured, never stored**. The persisted
entry holds only labels and token counts, so their text never reaches the session
file. Labels come from untrusted places (paths, tool names, `customType`s) and are
flattened to a single line before being persisted or drawn.

The report is a custom entry, not a message: it renders in the transcript and
never enters the conversation it is measuring. Outside TUI mode the same report is
delivered through `ctx.ui.notify` as plain text.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`registerCommand`, `registerEntryRenderer`, `appendEntry`, `getAllTools`, `getActiveTools`, `getSystemPrompt`, `getSystemPromptOptions`, `getContextUsage`, `sessionManager.buildContextEntries`, `estimateTokens`).
- **Depends on extensions:** None.
- **Used by extensions:** None.
- **Third-party packages:** None.
- **Platforms:** Cross-platform. The table renders in TUI mode; other modes get the same report as notified plain text.
