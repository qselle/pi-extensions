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

The panel starts with the active branch expanded. Use ↑/↓ to move, ←/→ to fold
or enter groups, and Space to toggle a group. It scrolls to the selection and
fits terminal height. `/plan status` prints the full tree. The compact card keeps
the active leaf visible even with a one-row allocation, and hides when every
leaf is completed or cancelled.

In narrow terminals, the shared workflow host shows a compact row above the
editor with plan progress and the active step. `/overlay hide` hides it too.

Plan state follows session branches and is injected only while active. Plans describe the current route through work; they do not replace persistent goal completion checks.

## Dependencies and limitations

Tool results show a short receipt and the active step. Expand the result or open `/plan` for the full tree.

- Up to 3 levels, 10 siblings per group and 40 total groups/steps. Names must be
  unique within a group; repeated names in different groups are allowed.
- Older flat plans remain readable. Fold state is local to the panel; the plan
  tree persists with session branches.
- Uses Pi's public extension, session, context, and TUI APIs.
- Requires [`overlay-stack`](../overlay-stack/).
- Uses host-provided `typebox` for the tool schema.
- Persistent TUI and RPC sessions are supported; panels require the TUI.
