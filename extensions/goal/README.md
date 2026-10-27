# goal

Keeps an explicit goal active across agent turns until it is completed, paused, repeatedly blocked, interrupted, or out of budget.

## Usage

Only `create_goal` is exposed before a goal exists. Reading, progress, reconciliation,
and lifecycle tools activate when a goal is created or restored.

```text
/goal                     Open the goal panel
/goal <objective>         Create and start a goal
/goal edit                Edit the objective
/goal pause               Pause continuation
/goal resume              Resume a paused or blocked goal
/goal complete            Mark the goal complete and show its stats
/goal block               Stop the goal as blocked (no attention alert)
/goal clear               Remove the goal
```

Agent tools:

| Tool | Purpose |
|---|---|
| `get_goal` | Read the goal, checks, usage, and status |
| `create_goal` | Create a goal after an explicit user request |
| `report_goal_progress` | Maintain up to eight completion checks |
| `update_goal` | Mark a verified goal complete or report a blocker |
| `reconcile_goal` | Keep, revise, or explicitly pause the goal for the latest user request |
| `resume_goal` | Resume an inactive goal at the user's explicit request |
| `clear_goal` | Clear an inactive goal after explicit cancellation or replacement |

Only one check may be in progress. `create_goal` also accepts plain-string checks; when none is in progress, the first pending check starts. A confirmed third blocker report ends the run immediately. Completion is rejected while a non-cancelled check is unfinished. The same blocker must be reported in three consecutive goal runs before the goal stops as blocked.

Blocker reports can include a stable `condition_id`. Reuse it for the same
underlying condition as wording, evidence, or next-input details change; a different
ID starts a new audit. Without an ID, matching uses the normalized blocker text and
required next input. No semantic or fuzzy matching is performed.

Cancelled checks are excluded from completion totals. Cancelling a check requires a user-approved scope change; the agent must still verify the objective before completing the goal.

Continuation waits for Pi to be idle with no queued user input. Interruptions pause the goal; budget limits stop automatic work. A provider error stops the goal only if the settled run still ends with it, so Pi's own retries and compaction can recover first. Retries, compaction and queued work count as one run for turn totals and blocker audits. State follows session branches.

Token budgets count input, output and cache writes; cached prompt reads are excluded. Usage is saved when a run settles. Completion shows runs, time and tokens.

### Prompt cache

Goal state reaches the model as hidden append-only anchors that restate only the goal ID, status, objective, checks and latest progress summary. An anchor is added only when the visible conversation stops showing the current state: after `/goal` commands, extension-driven transitions such as stalls, compaction, branch changes, or restore. Goal tool results count as showing the state they return. Usage, timing and run counters never enter anchors; `get_goal` reports them. The goal rules are guidelines of the goal controls, which activate once per session.

Each automatic continuation persists one short wake message. Earlier anchors and messages are never rewritten or pruned, so the request prefix stays identical between turns. Older sessions' per-run `goal-context` markers are dropped consistently.

New interactive or RPC input to an active goal creates a persisted reconciliation
request, delivered once as a hidden message with its `request_id`. The agent
must reconcile it before updating progress, completing the goal, reporting a blocker,
or continuing automatically. `keep` preserves scope, including when answering a
status question. `revise` requires the complete objective and complete checks list
(`[]` when none apply). Revision preserves the goal ID, original creation time,
history, token budget, and lifetime token, time, turn, and continuation totals.

If a run ends without reconciliation, the goal stalls with a clear recovery message
and the usual attention event. This safety boundary prevents acting on unreconciled
scope; it is distinct from an explicit user pause and does not claim the user asked to stop.
Pending requests survive provider errors, reloads, and branch navigation. Reloading
invalidates old request tokens; controls use `goal_id` and `request_id` from
`get_goal` or the current goal context. Failed validation leaves the previous
objective and pending request intact.

Inactive goals stay out of unrelated requests: input adds no reconciliation, hidden
context, or settle notice. `get_goal` returns the current `request_id`. When
explicitly asked to continue, the agent calls `resume_goal`, which turns the request
into a reconciliation, before `reconcile_goal`; resumption resets the blocker audit but preserves lifetime totals.
An exhausted token budget cannot resume. A goal may still be marked complete during
the run that exhausted its budget if all work and checks are already verified.
For explicit cancellation, reconcile an active goal with `pause`, then call
`clear_goal` with the same identifiers. Clearing appends a state entry and preserves
history. Direct `/goal resume` confirms the current objective and clears pending
reconciliation; `/goal edit` and the confirmed `/goal clear` remain available.

At startup or resume with a UI, a paused, stalled, blocked or usage-limited goal offers Resume, Keep, or Clear.

Completed goals emit one `goal:completed` event for optional consumers such as [`telegram`](../telegram/).

Persisted goal changes and branch restoration emit `goal:changed` with a version and status only. [`notify`](../notify/) uses this to suppress routine completion pings while a goal is active, without receiving objective text.

When enabled, [`telegram`](../telegram/) sends one metadata-only card when a goal
becomes blocked, stalled, budget-limited, or usage-limited. Unchanged or restored
states are quiet; pausing or clearing does not alert. These cards omit the objective,
blocker details, and raw provider errors.

## Dependencies and limitations

- Uses Pi's extension, session, context, and TUI APIs.
- Requires [`overlay-stack`](../overlay-stack/) for the status card.
- Uses host-provided `typebox` for tool schemas.
- Goal state and tools work in persistent TUI and RPC sessions. The panel requires the TUI; automatic continuation requires a TUI or RPC client and does not run in print or JSON mode.
