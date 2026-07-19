# goal

A persistent, self-continuing goal loop for Pi. An active goal keeps Pi working across agent runs until it is verified complete, repeatedly blocked, paused, interrupted, or out of budget.

A compact widget shows status, elapsed time, budget, completed checks, and the current check. Run `/goal` for the expanded interactive panel.

## Commands

```text
/goal                     Open the goal panel
/goal <objective>         Set and start a goal
/goal edit                Edit the objective
/goal pause               Pause automatic continuation
/goal resume              Resume a paused or blocked goal
/goal clear               Clear the goal
```

## Agent tools

- `get_goal` reads objective, progress, blocker, time, and budget.
- `create_goal` starts a goal only after an explicit request.
- `report_goal_progress` maintains up to eight concrete checks, with at most one in progress.
- `update_goal` completes a fully verified goal or reports a blocker.

Completion is rejected while a non-cancelled progress check remains unfinished. A blocker stops the loop only after the same condition is reported in three separate consecutive goal runs.

## Safety

- Continuations start only after Pi is fully idle and no user input is queued.
- Interrupting a run pauses the goal.
- Provider failures and exhausted budgets stop automatic work.
- Three no-tool continuation runs stop the loop to prevent spinning.
- Full goal context is injected transiently; session history stores only small wake/context markers.
- State follows Pi session branches and active goals resume after session restore.
