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

Context and runtime:

`spawn.context` accepts:

- `fresh` (default): task plus normal project instructions, without parent messages.
- `summary`: a bounded model-generated parent handoff.
- `fork`: a compaction-aware copy of the active parent conversation.

Children inherit the working directory, active tools except `subagents`, project instructions, model, and thinking level. `model` and `thinking` may be overridden per spawn. Recursive child spawning is disabled.

Children share the working tree. Parallel writers must use disjoint files; the parent is responsible for reviewing their changes.

Completion and UI:

Completed children deliver one bounded result to the parent unless a `wait` call already owns it. Running children appear in [`overlay-stack`](../overlay-stack/), and `/subagents` opens a live transcript. Child usage is shown separately in the footer and stored as non-context parent session entries.

Session transitions invalidate pending transcript selections and close an open viewer. A stale selection cannot open a child transcript in the replacement session. [`usage-export`](../usage-export/) includes recorded child token categories and costs without exporting child task text or names.

Closed-child transcripts retain the latest 500 entries in memory until the parent
runtime ends. Persisted parents keep child conversation files under
`<parent-session-file>.subagents/`, with state and pinned conversation leaves in
non-context parent entries. Reload/quit stop child processes. Reopening restores
stopped children and unread final results; it never starts a model call. `send`
explicitly resumes from a copy of the saved conversation. Older branch checkpoints
do not include later child turns. `/subagents` can inspect saved transcripts.

Closing, interrupting, or leaving the session also cancels a resume still starting
up. Cancelling a `send` before dispatch starts no child turn and keeps queued input
for a later explicit send; `interrupt` intentionally clears that input.

Queue-only messages survive a normal reload. `interrupt` discards this inbox and
clears the RPC input queue before and after aborting. Submitted queued messages
are removed before RPC dispatch, so an ambiguous failure cannot replay them.
Automatic completions count as delivered after the message actually appears in
the parent branch; a queued but unpersisted notification remains readable after
reload. `read`/`wait` retrieve retained results without an automatic wakeup.

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
- Requires the configured model provider; `summary` context makes an additional model call through Pi's authenticated model registry, including configured custom providers. Failed or cancelled summaries are rejected. Fork context preserves Pi 0.86 transcript prompt/tool updates.
- Validated on macOS and Linux. Windows remains unverified. Cleanup uses Unix process groups or Windows `taskkill`.
- Tool orchestration works in non-interactive modes; the overlay and transcript viewer require the TUI.
