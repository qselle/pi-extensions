# plan

Tracks a multi-step plan in one line above the editor, with full details on demand.

```text
Plan 1/3 · ● Verify the implementation                              /plan
```

## Usage

```text
/plan          Open the plan panel
/plan compact  One progress line above the editor (default)
/plan card     Small card with the current and next steps
/plan hide     Hide the passive display; keep tracking
/plan status   Print the current plan
/plan clear    Remove the plan
/overlay       Toggle all workflow cards
Ctrl+Shift+O   Toggle all workflow cards
```

The `update_plan` agent tool replaces the complete plan tree. Leaf steps are
`pending`, `in_progress`, `completed`, or `cancelled`. An unfinished plan must have
exactly one in-progress leaf. Groups use a `children` array and may omit `status`;
their status and progress are derived from descendants, so a parent cannot claim
completion over unfinished children. Progress counts leaves, not parent groups.
Cancelled work remains separate from successful completion in progress totals.

Example tool input:

```json
{
  "plan": [
    {
      "step": "Build the feature",
      "children": [
        { "step": "Implement", "status": "completed" },
        { "step": "Verify behavior", "status": "in_progress" }
      ]
    },
    { "step": "Document usage", "status": "pending" }
  ]
}
```

The default line shows completed/total steps and the current task. Cancelled
steps are counted separately. Display choices follow the session branch through
reload and navigation. Finished plans disappear from the passive display.

The optional card has at most three body rows: current step, next pending step,
and a remaining count. It falls back to the progress line in narrow terminals.
`/overlay hide` hides either presentation.

The panel starts with the active group expanded. Use ↑/↓ to move, ←/→ to fold
or enter groups, Space to toggle a group, and `q` or Escape to close.
`/plan status` prints the full tree. Explanations and completed steps remain
available in the panel and expanded tool results.

Plan state follows session branches and is injected only while active. Plans describe the current route through work; they do not replace persistent goal completion checks.

## Dependencies and limitations

Tool results use a single-line receipt. Expand the result or open `/plan` for the full tree.

- Up to 3 levels, 10 siblings per group and 40 total groups/steps. Names must be
  unique within a group; repeated names in different groups are allowed.
- Older flat plans remain readable. Fold state is local to the panel; the plan
  tree persists with session branches.
- Uses Pi's public extension, session, context, and TUI APIs.
- Requires [`overlay-stack`](../overlay-stack/).
- Uses host-provided `typebox` for the tool schema.
- Persistent TUI and RPC sessions are supported; panels require the TUI.
