# subagents

Persistent child agents for delegated and parallel work. Each child runs in an isolated Pi RPC process with its own context window and reusable conversation while the parent continues working.

The extension intentionally exposes lifecycle operations rather than a one-shot “run these tasks” wrapper. Spawn independent work, continue locally, steer or interrupt a child when needed, wait only when blocked, and close children when their context is no longer useful.

## Agent tool

The `subagents` tool supports six actions:

| Action | Required fields | Behavior |
|---|---|---|
| `spawn` | `name`, `task` | Starts a uniquely named child and returns immediately; accepts `context`, `model`, and `thinking` overrides |
| `send` | `agent_name`, `message` | Steers a running child or starts a follow-up turn in an idle child |
| `interrupt` | `agent_name` | Aborts the current child turn without closing its conversation |
| `wait` | — | Waits for any/all selected children, with timeout and cancellation support |
| `list` | — | Returns current child status without waiting |
| `close` | `agent_name` | Stops the process, removes temporary context, and releases capacity |

Multiple `spawn` tool calls in the same parent response start concurrently. Names are reserved atomically and are case-insensitively unique for the parent session, including after a child closes.

Example delegation:

```text
Spawn “api audit” to inspect API compatibility without editing files.
Spawn “test gaps” to identify missing edge cases while you continue implementing.
```

## Context modes

`spawn.context` controls parent-conversation inheritance:

- `fresh` — default; no parent messages, only the explicit task and normal project instructions.
- `summary` — creates a compact structured handoff from the active parent conversation. Concurrent spawns at the same parent position reuse the handoff.
- `fork` — copies the active, compaction-aware parent conversation into the child.

Summary and fork modes exclude the unresolved parent assistant turn that invoked the subagent, avoiding dangling tool calls in the child session. Context is advisory; every spawn still needs a complete, bounded task.

## Runtime inheritance

Children inherit the parent’s:

- current model and thinking level
- active tool set, except the `subagents` tool
- working directory
- global/project instructions, skills, and trusted project resources loaded by Pi

The `PI_SUBAGENT_CHILD` guard removes the orchestration tool from child processes, so recursive grandchildren are disabled.

### Model and thinking overrides

Inheritance is the default. A spawn may optionally set:

```json
{
  "action": "spawn",
  "name": "fast scout",
  "task": "Map the authentication implementation and report exact paths.",
  "model": "provider/model-id",
  "thinking": "low"
}
```

Model overrides use `provider/model` format, support model IDs that contain additional `/` characters, and are validated against Pi's model registry and available credentials before creating a child. Thinking accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; Pi clamps unsupported levels to the selected model's capabilities.

Use overrides only for an explicit user request or a concrete task-specific cost, speed, or capability reason. The effective model and thinking level are shown in spawn output, the live overlay, `/subagents`, completion cards, and usage details. A child keeps its selected runtime for all follow-ups; changing the parent model affects only later spawns.

## Completion and UI

A completed child automatically injects one bounded completion message into the parent and wakes it if idle. If `wait` owns that completion first, automatic delivery is suppressed; a late wait avoids duplicating an already delivered result.

Running children appear in the shared top-right workflow overlay with task, selected runtime, latest tool activity, and aggregate usage. `/subagents` opens a selectable live transcript for running, completed, failed, and closed children. The viewer groups Task, Thinking, Agent, Tool, Tool result, Shell, and Follow-up blocks; it starts at the newest entry, pauses tail-following when you scroll up, and resumes with End. Use arrows, PageUp/PageDown, Home/End, and `q`/Escape to navigate.

Transcripts read the child's real temporary Pi session while it runs. Up to 500 latest entries are retained in memory before cleanup so a closed child remains inspectable for the rest of the parent runtime. Inherited parent messages and the orchestration wrapper prompt are omitted from the viewer.

Tool results and automatic completions support Pi’s collapsed/expanded rendering.

### Footer usage

Each billed child response updates a compact footer status such as `agents ↑12k ↓850 R20k $0.0421`. Usage records are stored as non-context parent session entries and rebuilt from the active branch after reload or tree navigation. The aggregate includes child input, output, cache-read, cache-write, and cost without changing the parent model's independent context percentage.

## Concurrency and write safety

Up to six child processes may remain open by default. Starting, running, and completed-but-open children consume capacity. Close a child after collecting its final result when no follow-up is needed.

Children share the same working tree. Parallel research is safe, but parallel writers must have disjoint file scopes. The parent should review child changes before integrating or reporting success.

## Configuration

Set the maximum number of open children before launching Pi:

```bash
export PI_SUBAGENT_MAX_OPEN=4
```

Accepted values are `1` through `16`; invalid values fall back to `6`.

Per-call limits:

- names: 64 characters
- tasks and follow-ups: 16,000 characters
- automatic/final result: 24 KiB
- combined tool output: 48 KiB
- wait timeout: 0 to 300,000 ms
- one RPC record: 2 MiB
- retained stderr tail: 16 KiB
- retained closed-child transcript: latest 500 session entries

## Cancellation and cleanup

- Aborting `spawn` cancels startup and removes any temporary session.
- Aborting `wait` stops waiting but does not kill children.
- `interrupt` aborts a child turn while preserving its conversation for follow-up.
- `close`, `/reload`, session replacement, and Pi shutdown terminate the complete child process tree and remove temporary sessions.
- RPC dialogs are automatically declined because child processes have no interactive UI.
- Startup, dispatch, provider, process-exit, oversized-record, and cleanup failures are surfaced as tool errors or failed child results.

## Dependencies and limitations

- **Runtime:** Pi’s public extension, session, model, tool, TUI, and RPC APIs.
- **Third-party packages:** None; Pi-provided packages are supplied by the host.
- **External services:** The configured model provider used by each child and by `summary` context generation.
- **Platforms:** macOS, Linux, and Windows are supported. Process-tree termination uses Unix process groups or Windows `taskkill`.
- **Persistence:** Child conversations are intentionally temporary and live only for the current parent runtime. Completion messages and usage records remain in the parent session; the latest 500 transcript entries remain inspectable in memory after close until that runtime ends.
- **Usage accounting:** Child usage is restored per active parent branch and displayed as a dedicated built-in footer status. Pi does not expose a public API for mutating its core parent token counters, so child totals remain visibly separate and do not change the parent model’s context percentage.
- **Non-interactive modes:** Tool orchestration works, but overlay and detail panels require the interactive TUI.
