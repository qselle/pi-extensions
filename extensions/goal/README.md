# goal

Keeps an explicit goal active across agent turns until it is completed, paused, repeatedly blocked, interrupted, or out of budget.

## Usage

Only `create_goal` is exposed before a goal exists. Reading/updating/progress
tools activate when a goal is created or restored.

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

Only one check may be in progress. Completion is rejected while a non-cancelled check is unfinished. The same blocker must be reported in three consecutive goal runs before the goal stops as blocked.

Cancelled checks are displayed separately and excluded from the completion fraction. They are not evidence of success: the goal prompt requires cancellation to reflect a user-approved scope change, and requires verification of the full original objective before completion. These semantic requirements rely on the agent's audit; the extension cannot prove real-world task success from checklist status alone.

Actions from a panel, editor, or confirmation are discarded if the goal changes or the session switches while the dialog is open. A dialog completing after shutdown cannot restart automatic continuation.

Continuation waits for Pi to be idle with no queued user input. Interruptions pause the goal; provider failures and budget limits stop automatic work. Goal context is expanded only for the active turn, while session history stores small state markers. State follows session branches.

Completed goals emit one `goal:completed` event for optional consumers such as [`telegram`](../telegram/).

Persisted goal changes and branch restoration emit `goal:changed` with a version and status only. [`notify`](../notify/) uses this to suppress routine completion pings while a goal is active, without receiving objective text.

## Dependencies and limitations

- Uses Pi's extension, session, context, and TUI APIs.
- Requires [`overlay-stack`](../overlay-stack/) for the status card.
- Uses host-provided `typebox` for tool schemas.
- Works in persistent TUI and RPC sessions; the panel requires the TUI.
