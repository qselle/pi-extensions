# subagents

Runs child agents in separate Pi RPC processes with their own context windows and reusable conversations.

## Usage

The `subagents` tool supports:

| Action | Purpose |
|---|---|
| `spawn` | Start a named child and return immediately |
| `send` | Steer a running child or explicitly resume/start a follow-up, consuming queued messages |
| `queue` | Store a message without starting or steering a child; consumed by the next send |
| `read` | Retrieve the latest output and acknowledge an unread final |
| `interrupt` | Stop the current child turn but keep its conversation |
| `wait` | Wait for selected children without killing them on cancellation |
| `list` | Show child state |
| `close` | Stop a child, remove temporary context, and release capacity |

Concurrent `spawn` calls start in parallel. Names are case-insensitively unique for the parent session.

### Context and runtime

`spawn.context` accepts:

- `fresh` (default): task plus normal project instructions, without parent messages.
- `summary`: a bounded model-generated parent handoff.
- `fork`: a compaction-aware copy of the active parent conversation.

Children inherit the working directory, active tools except `subagents`, project instructions, model, and thinking level. They also receive the child-only `report_to_parent` tool. `model` and `thinking` may be overridden per spawn. Recursive child spawning is disabled.

Children share the working tree. Parallel writers must use disjoint files; the parent is responsible for reviewing their changes.

### Results and persistence

Completed children deliver one bounded result to the parent unless a `wait` call already owns it. Running children appear in [`overlay-stack`](../overlay-stack/), and `/subagents` opens a live transcript. Each child response stores its usage as a non-context parent session entry. The [`footer`](../footer/) adds these deltas to its main token/cache/cost counters, including after reload; context percentage remains specific to the parent. Omitted or invalid metrics remain unknown rather than being saved as zero. Child state snapshots and completion cards do not add usage a second time.

Children can call `report_to_parent({ message })` for a material interim finding
that unblocks or redirects the parent. Ordinary commentary remains local. Reports
use the existing RPC tool-result channel and are accepted only after successful
execution; duplicate events and stale child processes cannot redeliver them.
An interim card appears at the parent's next safe boundary, or immediately when
idle, without starting a parent model turn. Final completion delivery is unchanged.

`wait_mode: "any"` returns when a selected child finishes; `"all"` waits for every
selected final. The default `wake_on: "final"` preserves this behavior.
`wake_on: "any"` also wakes an `any` wait for an explicit interim report from a
selected child. It does not wake for routine commentary or unrelated children.
Already finished targets return immediately in an `any` wait. Default targets
include running children and retained unread results. Only one wait may own a
child at once; cancellation and timeouts leave child processes running.

`read` explicitly retrieves retained reports and the latest response again.
`wait` consumes new reports and finals once. A prior report-only wait does not
acknowledge a later final. Child run IDs keep repeated runs distinct even when
timestamps match, and branch transitions cannot return or consume stale results.

[`usage-export`](../usage-export/) includes recorded child usage without exporting task text or names.

The child viewer uses the same Markdown, code rendering, search and navigation as `/transcript`. `/` searches, `n`/`N` steps through matches, `t` toggles thinking, Home goes to the task, and End resumes following. Scrolling pauses following. The full-width panel fits narrow terminals, and saved fallback results remain readable when a detailed transcript is unavailable.

Use `/subagents <name>` to open a child directly; command completion offers current names. With no name, `/subagents` opens the picker.

From a completely empty editor, Right opens the first active child, or the first
retained open child when none are active. Inside the viewer, Left/Right move
through children in creation order; Left from the first child returns to the
parent. Closed children are skipped but remain accessible by name. Each of the
eight most recently visited children keeps its search, scroll, thinking and
follow state while the viewer stays open. Arrows keep their normal behavior in
drafts, dialogs and the viewer's active search field. Esc or `q` closes the viewer.

Closed-child transcripts retain the latest 500 entries in memory until the parent
runtime ends. Persisted parents keep child conversation files under
`<parent-session-file>.subagents/`, with state and pinned conversation leaves in
non-context parent entries. Reload/quit stop child processes. Reopening restores
stopped children and unread final results; it never starts a model call. `send`
explicitly resumes from a copy of the saved conversation. Older branch checkpoints
do not include later child turns. `/subagents` can inspect saved transcripts.

Closing, interrupting, or leaving the session cancels a pending resume. Cancelling `send` before dispatch preserves queued input; `interrupt` clears it.

Queue-only messages survive a normal reload. `interrupt` discards this inbox and
clears the RPC input queue before and after aborting. Submitted queued messages
are removed before RPC dispatch, so an ambiguous failure cannot replay them.
Automatic completions count as delivered after the message actually appears in
the parent branch; a queued but unpersisted notification remains readable after
reload. `read`/`wait` retrieve retained results without an automatic wakeup.

Reports follow the same restoration rule: actual parent message or `read`/`wait`
entries acknowledge delivery, not an optimistic queued flag. The latest eight
report previews per child and 64 recent report IDs are retained; delivered previews
are evicted first. If unread previews overflow, the result states how many were
omitted and points to the full child transcript. Old report text remains in saved
session history. Each report is limited to 4,000 characters.

In-memory parent sessions have no durable conversation directory. Missing, moved,
unsafe or oversized child files fail explicitly on resume; bounded result text
remains in the parent checkpoint. Checkpoints above 64 MiB are not reopened.
Closing removes the current child copy; historical branch copies remain alongside
the parent session for recovery and can be removed when that session is discarded.

## Configuration

Set the open-child limit before starting Pi:

```bash
export PI_SUBAGENT_MAX_OPEN=4
```

Accepted values are 1–16; the default is 6. At most 16 child conversations remain retained in a session; close one before adding more. Starting, running, idle, and completed-but-open processes consume capacity. Restored stopped children do not consume process capacity until resumed.

Tasks and follow-ups are limited to 16,000 characters; wait timeouts to 300 seconds; queued messages to 8 per child; final results to 24 KiB; combined tool output to 48 KiB; RPC records to 2 MiB.

`close`, reload, session replacement, and Pi shutdown terminate child process trees. Reload/quit retain durable session checkpoints; close removes the current child copy. RPC dialogs are declined because children have no interactive UI.

## Dependencies and limitations

- Uses Pi's public extension, session, model, tool, TUI, and RPC APIs plus host-provided `typebox`.
- Requires the configured model provider; `summary` context makes an additional model call through Pi's authenticated model registry, including configured custom providers. Failed or cancelled summaries are rejected. Fork context preserves transcript prompt/tool updates.
- Validated on macOS and Linux. Windows remains unverified. Cleanup uses Unix process groups or Windows `taskkill`.
- Tool orchestration works in non-interactive modes; the overlay and transcript viewer require the TUI.
