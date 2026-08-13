# overlay-stack

Provides one top-right overlay for workflow cards from `goal`, `plan`, `subagents`, and `file-changes`.

## Usage

```text
/overlay                 Toggle the stack
/overlay show|hide       Change visibility
/overlay status          Show visibility
Ctrl+Shift+O             Toggle the stack
```

The overlay does not capture keyboard input or consume transcript rows. It hides while a full-screen extension panel is open. Card state continues updating while hidden.

Cards are ordered by priority and sized to the live terminal. Lower-priority cards are omitted if the stack would exceed 80% of terminal height. Visibility resets on reload or a new session.

There is no timer. Redraws occur only when card state changes.

## Dependencies and limitations

- Uses Pi's public extension, overlay, and TUI APIs.
- No third-party packages or configuration files.
- Interactive TUI only; cross-platform.
- Pi does not expose terminal scrollback state, so the overlay is anchored to the live viewport only.
