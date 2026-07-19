# goal

A persistent, self-continuing goal loop for Pi. An active goal keeps Pi working across agent runs until it is verified complete, repeatedly blocked, paused, interrupted, or out of budget.

A compact card in the shared top-right workflow overlay shows status, elapsed time, budget, validation progress, and the current check. Run `/goal` for the expanded interactive panel.

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

Goal checks are durable acceptance and verification criteria. They intentionally do **not** mirror `update_plan`: the plan is a mutable route through the work and may change without redefining what proves the goal complete.

## Completion events

A genuine transition to `complete` emits the versioned `goal:completed` extension event. Normal emission is deferred until `message_end` and `agent_settled` finish the run's token and elapsed-time accounting; session shutdown provides a guarded fallback. The immutable payload contains a unique completion ID, completion timestamp, and final goal snapshot. Duplicate completion calls and restoration of completed state do not emit another event.

[`telegram-notify`](../telegram-notify/) consumes this event without coupling external network behavior to the goal loop.

## Safety

- Continuations start only after Pi is fully idle and no user input is queued.
- Each continuation stores a small hidden wake marker and replaces that marker with the full objective only in transient model context, including for a fresh provider conversation.
- Interrupting a run pauses the goal.
- Provider failures and exhausted budgets stop automatic work.
- If implementation continues after a transient failure, a concrete `report_goal_progress` call automatically revives a stalled goal and attaches the current run to it. Paused, blocked, and usage-limited goals still require explicit user action.
- A no-tool continuation that exactly replays the previous assistant response stalls immediately.
- Three other empty continuation runs mark the goal stalled and pause the loop without misreporting a blocker.
- Full goal context is injected transiently; session history stores only small wake/context markers.
- State follows Pi session branches and active goals resume after session restore.
- The card is registered with [`overlay-stack`](../overlay-stack/); use `Ctrl+Shift+O` or `/overlay` to hide or show all workflow cards.
- The goal card has no periodic timer. It updates on state changes so it does not continually force terminal scrollback to the bottom.

## Dependencies

- **Runtime:** Pi's extension and TUI APIs.
- **Depends on extensions:** [`overlay-stack`](../overlay-stack/).
- **Third-party packages:** None.
