# goal

Keeps an explicit goal active across agent turns until it is completed, paused, repeatedly blocked, interrupted, or out of budget.

## Usage

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

Continuation waits for Pi to be idle with no queued user input. Interruptions pause the goal; provider failures and budget limits stop automatic work. Goal context is expanded only for the active turn, while session history stores small state markers. State follows session branches.

Completed goals emit one `goal:completed` event for optional consumers such as [`telegram`](../telegram/).

## Dependencies and limitations

- Uses Pi's extension, session, context, and TUI APIs.
- Requires [`overlay-stack`](../overlay-stack/) for the status card.
- Uses host-provided `typebox` for tool schemas.
- Works in persistent TUI and RPC sessions; the panel requires the TUI.
