# overlay-stack

A shared, persistent top-right overlay for workflow cards. Feature extensions register independent cards; this extension owns their framing, ordering, responsive sizing, visibility, and lifecycle.

Current cards:

- `goal` — durable objective and validation state
- `plan` — current tactical execution route
- `subagents` — running delegated child agents and their latest activity
- `file-changes` — files changed in the active or most recently completed run

Cards are anchored to Pi's live terminal viewport in a non-capturing overlay, so the editor keeps keyboard focus and the cards do not consume transcript rows. The host redraws only when card state changes; it deliberately has no animation or one-second timer because periodic renders can pull some terminals back to the bottom of scrollback.

Pi does not expose public transcript scroll state, and native terminal scrollback cannot provide a truly sticky overlay over historical rows. The stack therefore uses the strongest supported behavior—viewport anchoring without timer-driven redraws—rather than private scroll hooks.

## Controls

```text
/overlay                 Toggle the stack
/overlay toggle          Toggle the stack
/overlay show|hide       Show or hide the stack
/overlay status          Report visibility
Ctrl+Shift+O             Toggle the stack
```

The stack hides temporarily while the goal panel, plan panel, history search, or subagent transcript is open and restores afterward unless the user hid it manually. Manual visibility resets for a new session or extension reload.

On narrow or short terminals, cards hide responsively. If all cards cannot fit within 80% of terminal height, lower-priority cards are omitted rather than covering the editor.

## Design

The registry is process-global because Pi may evaluate a package entry point and a sibling relative import as separate Jiti module instances. Cards own their state and rendering; the stack owns only composition. This keeps goal validation, plan execution state, subagent orchestration, and file-change tracking independent.

The workflow stack uses only Pi's public overlay API; unlike the cat's editor-placement compatibility shim, it does not patch private compositor behavior.

## Dependencies

- **Runtime:** Pi's public extension and TUI APIs.
- **Third-party packages:** None.
