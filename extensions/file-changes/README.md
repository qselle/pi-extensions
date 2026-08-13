# file-changes

Shows net file changes from Pi's built-in `edit` and `write` tools in the shared workflow overlay.

## Usage

```text
/file-changes              Toggle the card
/file-changes show|hide    Change visibility
/file-changes status       Show visibility and tracked file count
/overlay                   Toggle all workflow cards
Ctrl+Shift+O               Toggle all workflow cards
```

The extension records a file before its first mutation in a run and compares that baseline with its latest contents. Reverted files disappear from the card. The completed summary is stored as non-context session state and restored per branch after reload, resume, or tree navigation.

Hiding the card does not stop tracking. Visibility itself resets on reload.

## Dependencies and limitations

- Uses Pi's extension, tool-event, session, and TUI APIs.
- Requires [`overlay-stack`](../overlay-stack/); uses [`hyperlinks`](../hyperlinks/) for clickable paths.
- No third-party packages or executables.
- Tracks successful local built-in `edit` and `write` calls only. Changes from shell commands, custom tools, remote tools, and external programs are not included.
- Interactive TUI only; the card requires at least 72 columns and 12 rows.
