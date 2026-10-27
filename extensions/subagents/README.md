# subagents

Runs child agents in separate Pi RPC processes with their own context windows and reusable conversations.

## Usage

The `subagents` tool supports:

| Action | Purpose |
|---|---|
| `spawn` | Start a named child and return immediately |
| `send` | Steer a running child or resume a settled, paused or stopped one, consuming queued messages |
| `queue` | Store a message without starting or steering a child; consumed by the next send |
| `read` | Retrieve the latest output and acknowledge an unread final |
| `interrupt` | Stop the current child run without a completion; `send` resumes it |
| `wait` | Wait for selected children without killing them on cancellation |
| `list` | Show child state |
| `close` | Stop a child, remove temporary context, and release capacity |

Concurrent `spawn` calls start in parallel. Names are case-insensitively unique for the parent session.

### Argument aliases

Before validation, the tool maps argument shapes common in other agent tool sets
onto its schema:

| Alias | Becomes |
|---|---|
| `action: "followup"` | `send` (steer if running, otherwise resume) |
| `action: "message"` | `send` (steer) when the child is running, otherwise `queue` |
| `context: "compacted"` / `"forked"` | `summary` / `fork` |
| `agent_id` / `agent_ids` | `agent_name` / `agent_names` |
| `name`, or a one-entry `agent_names`, on send/queue/read/interrupt/close | `agent_name` |
| `agent_name` or `name` on wait | `agent_names: [name]` |
| `return_when: "any" \| "all"` | `wait_mode` |
| `timeout_ms` outside 0–3,600,000 | clamped into range |

### Statuses

| Status | Meaning |
|---|---|
| `starting`, `running` | Child process is working |
| `completed` | Run finished; result delivered once |
| `paused` | Run ended on a provider quota, credit, billing, rate-limit (429) or overload error; the conversation is kept. `send` resumes it after the limit resets |
| `failed` | Run or process failed |
| `interrupted` | Stopped by `interrupt`; no completion is delivered and late child events are ignored. `send` resumes it |
| `stopped` | Restored after reload, quit or tree navigation; `send` resumes it |
| `closed` | Closed; no longer resumable |

Paused results use a warning colour and include resume guidance. The model is
told to resume paused or stopped children with `send` rather than spawn
replacements.

### Context and runtime

`spawn.context` accepts:

- `fresh` (default): task plus normal project instructions, without parent messages.
- `summary`: a bounded model-generated parent handoff.
- `fork`: a compaction-aware copy of the active parent conversation.

Children inherit the working directory, active tools except `subagents`, project instructions, model, and thinking level. They also receive the child-only `report_to_parent` tool. `model` and `thinking` may be overridden per spawn. Recursive child spawning is disabled. Child sessions are named `Subagent · <name>`, and the child process receives the parent session id in `PI_SUBAGENT_PARENT_SESSION_ID`.

Children share the working tree. Parallel writers must use disjoint files; the parent is responsible for reviewing their changes.

### Results and persistence

Completed children deliver one bounded result to the parent unless a `wait` call already owns it. Running children appear in [`overlay-stack`](../overlay-stack/), and `/subagents` opens a live transcript. Each child response stores its usage as a non-context parent session entry. The [`footer`](../footer/) adds these deltas to its main token/cache/cost counters, including after reload; context percentage remains specific to the parent. Omitted or invalid metrics remain unknown rather than being saved as zero. Child state snapshots and completion cards do not add usage a second time.

Children can call `report_to_parent({ message })` for a material interim finding
that unblocks or redirects the parent. Ordinary commentary remains local. Reports
use the existing RPC tool-result channel and are accepted only after successful
execution; duplicate events and stale child processes cannot redeliver them.
An interim card appears at the parent's next safe boundary, or immediately when
idle, without starting a parent model turn. Final completion delivery is unchanged.

`wait_mode: "any"` (alias `return_when`) returns when a selected child finishes;
`"all"` waits for every selected final. The default `wake_on: "final"` preserves this behavior.
`wake_on: "any"` also wakes an `any` wait for an explicit interim report from a
selected child. It does not wake for routine commentary or unrelated children.
Already finished targets return immediately in an `any` wait. Default targets
include running children and retained unread results. Only one wait may own a
child at once; cancellation and timeouts leave child processes running.
`timeout_ms` defaults to 300,000 (5 minutes) and is clamped to at most 3,600,000
(1 hour). A timed-out result states that the children keep working and that the
model must not interrupt, close, or ask healthy children to finalize because of
the timeout.

`read` explicitly retrieves retained reports and the latest response again.
`wait` consumes new reports and finals once. A prior report-only wait does not
acknowledge a later final. Child run IDs keep repeated runs distinct even when
timestamps match, and branch transitions cannot return or consume stale results.

[`usage-export`](../usage-export/) includes recorded child usage without exporting task text or names.
Older `subagent-usage` rows without agent id or name are counted when they record
a provider and model.

The child viewer uses the same Markdown, code rendering, search and navigation as `/transcript`. `/` searches, `n`/`N` steps through matches, `t` toggles thinking, Home goes to the task, and End resumes following. Scrolling pauses following. The full-width panel fits narrow terminals, and saved fallback results remain readable when a detailed transcript is unavailable.

Use `/subagents <name>` (alias `/agents`) to open a child directly; command completion offers current names. With no name, `/subagents` opens the picker.

From a completely empty editor, Right opens the first active child, or the first
retained open child when none are active. Inside the viewer, Left/Right move
through children in creation order; Left from the first child returns to the
parent. Closed children are skipped but remain accessible by name. Each of the
eight most recently visited children keeps its search, scroll, thinking and
follow state while the viewer stays open. Arrows keep their normal behavior in
drafts, dialogs and the viewer's active search field. Esc or `q` closes the viewer.

When a run settles, a child with a durable conversation stops its process
(hibernates). It keeps its conversation slot but no longer counts toward the
open-process limit. `send` starts a new process on the same child session file,
so the conversation continues in place. Children of in-memory parent sessions
have no durable file and keep their process until closed.

Subagent state is saved on lifecycle transitions: spawn, settle, follow-up,
queue, interrupt, report, close and suspend. Child tool activity alone saves state
at most once a minute, and child session files are reread only when the child
has produced events since the last read.

Closed-child transcripts retain the latest 500 entries in memory until the parent
runtime ends. Persisted parents keep child conversation files under
`<parent-session-file>.subagents/`, with state and pinned conversation leaves in
non-context parent entries. Reload/quit stop child processes. Reopening or tree
navigation restores stopped children and adds unread reports and final results to
the parent as passive messages; it never starts a model call. `send`
explicitly resumes from a copy of the saved conversation. Older branch checkpoints
do not include later child turns. `/subagents` can inspect saved transcripts.

Closing, interrupting, or leaving the session cancels a pending resume. Cancelling `send` before dispatch preserves queued input; `interrupt` clears it.

Queue-only messages survive a normal reload. `interrupt` discards this inbox and
clears the RPC input queue before and after aborting. Submitted queued messages
are removed before RPC dispatch, so an ambiguous failure cannot replay them.
Automatic completions count as delivered after the message actually appears in
the parent branch; a queued but unpersisted notification is added again, passively,
after reload. `read`/`wait` retrieve retained results without an automatic wakeup.

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

Accepted values are 1–16; the default is 6. The limit counts live child processes: starting and running children, plus settled children of in-memory parents. Hibernated, paused and restored children consume no process capacity until resumed. At most 16 child conversations remain retained in a session; close one before adding more.

Tasks and follow-ups are limited to 16,000 characters; wait timeouts to 1 hour (default 5 minutes); queued messages to 8 per child; final results to 24 KiB; combined tool output to 48 KiB.

RPC records above 2 MiB are discarded while streaming instead of failing the child. Pi's `agent_end` repeats every message of a run, so long runs exceed this routinely. The child's activity notes each skipped record type and size; an oversized assistant `message_end` replaces the retained result with a note pointing to the child session file, and an oversized command response rejects only that command.

`close`, reload, session replacement, and Pi shutdown terminate child process trees. Reload, quit and tree navigation first ask running children to abort, waiting at most 500 ms, so they record the interrupted turn. One process-wide exit handler, shared across `/reload`, kills remaining child process groups and is removed when none are live. Reload/quit retain durable session checkpoints; close removes the current child copy. RPC dialogs are declined because children have no interactive UI.

## Dependencies and limitations

- Uses Pi's public extension, session, model, tool, TUI, and RPC APIs plus host-provided `typebox`.
- Requires the configured model provider; `summary` context makes an additional model call through Pi's authenticated model registry, including configured custom providers. Failed or cancelled summaries are rejected. Fork context preserves transcript prompt/tool updates.
- Validated on macOS and Linux. Windows remains unverified. Cleanup uses Unix process groups or Windows `taskkill`.
- Tool orchestration works in non-interactive modes; the overlay and transcript viewer require the TUI.
