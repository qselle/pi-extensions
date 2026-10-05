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

Steps and groups accept an optional `description` (up to 600 characters) for
implementation context or verification details. Keep `step` concise. Descriptions
are saved with the plan, included in tool results and checkpoints, and shown when their
row is selected in `/plan`. Long descriptions remain complete in `/plan status`
and expanded tool results; the passive progress line stays compact.

While a plan is unfinished, updates must retain every completed leaf at its
existing group path with `completed` status. Future work can be refined and
reordered. Matching ignores case and extra whitespace; identically named steps
in different groups remain separate milestones. An invalid replacement leaves
the current plan and saved history intact.

For a new objective requested by the user, `update_plan` accepts `reset: true`
with a required `explanation` describing the change. `/plan clear` is the
interactive reset and asks for confirmation. Once all work is completed or
cancelled, the next plan can start fresh without reset. Earlier snapshots remain
in the session history.

Example tool input:

```json
{
  "plan": [
    {
      "step": "Build the feature",
      "children": [
        { "step": "Implement", "status": "completed" },
        { "step": "Verify behavior", "description": "Check reload, cancellation and narrow-terminal rendering.", "status": "in_progress" }
      ]
    },
    { "step": "Document usage", "status": "pending" }
  ]
}
```

### Flat rows

The schema is strict (`additionalProperties: false`) and calls run one at a
time (`executionMode: "sequential"`). Before validation, a compatibility shim
accepts the flat shape some models emit:

- rows with `depth` (0 = top level, growing by at most one per row, up to 2)
  are nested into `children` under the closest preceding shallower row;
- `reason` becomes `explanation` (an explicit `explanation` wins);
- parent rows may omit `status`; it is derived from their children.

```json
{
  "reason": "Split verification",
  "plan": [
    { "step": "Build", "depth": 0 },
    { "step": "Implement", "status": "completed", "depth": 1 },
    { "step": "Verify", "status": "in_progress", "depth": 1 }
  ]
}
```

Invalid depths are rejected with an error that points to `children`.

## Display

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

Plans describe the current route through work; they do not replace persistent goal completion checks.

## Model context

Each `update_plan` result already shows the model the complete plan, so nothing
is added to individual provider requests. This keeps the conversation prefix
identical between requests and preserves prompt caching.

A hidden `plan-context` checkpoint is appended to the session only when the
visible conversation stops showing the current plan:

- after compaction removes the latest `update_plan` result;
- after `/tree` navigation, resume, or reload when the branch's visible
  messages show a different plan;
- after `/plan clear`, as one notice that the earlier plan no longer applies.

The newest visible `update_plan` result or checkpoint is compared with the
current plan first, so repeated restores never send a duplicate. Finished plans
are treated like no plan. Plan state follows session branches.

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
