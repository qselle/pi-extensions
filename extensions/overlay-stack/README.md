# overlay-stack

Hosts top-right workflow cards and compact progress lines above the editor.
Plans use a progress line by default; `/plan card` opts into a small card.

## Usage

```text
/overlay                 Toggle the stack
/overlay show|hide       Change visibility
/overlay status          Show visibility
Ctrl+Shift+O             Toggle the stack
```

The overlay does not capture keyboard input. It hides while a full-screen extension panel is open. Card state continues updating while hidden.

When a card cannot fit the terminal's width or available height, a compact summary appears
above the editor instead. It keeps the card title and its first priority body row
visible, including the active plan step. Up to three rows are used, fewer on short
terminals; additional workflows are counted. Cards that fit remain in the overlay
and are not duplicated below. `/overlay hide` hides both presentations.

Cards are ordered by priority and sized to the live terminal. If the stack would
exceed 80% of terminal height, lower-priority cards use the compact area instead.
Overall visibility resets on reload or a new session.

Cards share available rows; short cards leave space for larger ones. Renderers may be called twice with different budgets and must have no side effects.

## Dependencies and limitations

- Uses Pi's public extension, overlay, and TUI APIs.
- No third-party packages or configuration files.
- Interactive TUI only; cross-platform.
- Pi does not expose terminal scrollback state, so the overlay is anchored to the live viewport only.
