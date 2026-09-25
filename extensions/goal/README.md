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

Only one check may be in progress. Completion is rejected while a non-cancelled check is unfinished. The same blocker must be reported in three consecutive goal runs before the goal stops as blocked.

Blocker reports can include a stable `condition_id`. Reuse it for the same
underlying condition as wording, evidence, or next-input details change; a different
ID starts a new audit. Without an ID, matching uses the normalized blocker text and
required next input. No semantic or fuzzy matching is performed.

Cancelled checks are excluded from completion totals. Cancelling a check requires a user-approved scope change; the agent must still verify the objective before completing the goal.

Continuation waits for Pi to be idle with no queued user input. Interruptions pause the goal; provider failures and budget limits stop automatic work. Goal context is expanded only for the active turn, while session history stores small state markers. State follows session branches.

New interactive or RPC input creates a persisted reconciliation request. The agent
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

Inactive goals stay inactive after progress questions or scope reconciliation.
When explicitly asked to continue, the agent calls `resume_goal` before
`reconcile_goal`; resumption resets the blocker audit but preserves lifetime totals.
An exhausted token budget cannot resume. A goal may still be marked complete during
the run that exhausted its budget if all work and checks are already verified.
For explicit cancellation, reconcile an active goal with `pause`, then call
`clear_goal` with the same identifiers. Clearing appends a state entry and preserves
history. Direct `/goal resume` confirms the current objective and clears pending
reconciliation; `/goal edit` and the confirmed `/goal clear` remain available.

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
- Goal state and tools work in persistent TUI and RPC sessions. The panel and automatic continuation require the TUI.
