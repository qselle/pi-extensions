# plan

A tactical execution-plan companion for Pi. The agent maintains a concise plan with `update_plan`; active work appears as an independent card in the shared top-right workflow overlay, while `/plan` opens the full panel.

Plans complement persistent goals:

- A **goal** defines the durable objective and verification checks.
- A **plan** shows the current route through meaningful multi-step work.
- Goal continuations can create and update plans automatically.
- Goal checks and plan steps stay independent: changing the route must not redefine the goal's acceptance criteria.

## Commands

```text
/plan          Open the full plan panel
/plan status   Print the current plan
/plan clear    Clear the plan
/overlay       Toggle all workflow cards
Ctrl+Shift+O   Toggle all workflow cards
```

## Agent tool

`update_plan` replaces the complete current plan. Each step has one of:

- `pending`
- `in_progress`
- `completed`
- `cancelled`

An unfinished plan must have exactly one in-progress step. The card hides automatically after every step is completed or cancelled.

Plan state follows Pi session branches. Active plan context is injected transiently, including during automatic goal continuations.

The card is registered with [`overlay-stack`](../overlay-stack/) rather than owning another overlay. This keeps goal, plan, and future cards independently maintainable while sharing responsive layout and visibility controls.

## Dependencies

- **Runtime:** Pi's extension and TUI APIs.
- **Depends on extensions:** [`overlay-stack`](../overlay-stack/).
- **Third-party packages:** None.
