# subagents

Runs child agents in separate Pi RPC processes with their own context windows and reusable conversations.

## Usage

The `subagents` tool supports:

| Action | Purpose |
|---|---|
| `spawn` | Start a named child and return immediately |
| `send` | Steer a running child or start a follow-up |
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

Closed-child transcripts retain the latest 500 entries in memory until the parent runtime ends. Child sessions themselves are temporary.

## Configuration

Set the open-child limit before starting Pi:

```bash
export PI_SUBAGENT_MAX_OPEN=4
```

Accepted values are 1–16; the default is 6. Starting, running, idle, and completed-but-open children all consume capacity.

Tasks and follow-ups are limited to 16,000 characters; wait timeouts to 300 seconds; final results to 24 KiB; combined tool output to 48 KiB; RPC records to 2 MiB.

`close`, reload, session replacement, and Pi shutdown terminate child process trees and delete temporary sessions. RPC dialogs are declined because children have no interactive UI.

## Dependencies and limitations

- Uses Pi's public extension, session, model, tool, TUI, and RPC APIs plus host-provided `typebox`.
- Requires the configured model provider; `summary` context makes an additional model call.
- Supports macOS, Linux, and Windows. Cleanup uses Unix process groups or Windows `taskkill`.
- Tool orchestration works in non-interactive modes; the overlay and transcript viewer require the TUI.
