# plan

Shows the current multi-step execution plan in the shared workflow overlay and a full panel.

## Usage

```text
/plan          Open the plan panel
/plan status   Print the current plan
/plan clear    Remove the plan
/overlay       Toggle all workflow cards
Ctrl+Shift+O   Toggle all workflow cards
```

The `update_plan` agent tool replaces the complete plan. Steps are `pending`, `in_progress`, `completed`, or `cancelled`. An unfinished plan may have only one in-progress step. The card hides when every step is completed or cancelled.

Plan state follows session branches and is injected only while active. Plans describe the current route through work; they do not replace persistent goal completion checks.

## Dependencies and limitations

- Uses Pi's public extension, session, context, and TUI APIs.
- Requires [`overlay-stack`](../overlay-stack/).
- Uses host-provided `typebox` for the tool schema.
- Persistent TUI and RPC sessions are supported; panels require the TUI.
