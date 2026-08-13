# notify

Sends a desktop notification and terminal bell when a turn finishes or Pi needs questionnaire input.

Notifications are suppressed while the terminal is focused and while an active [`goal`](../goal/) is continuing. Identical notifications within five seconds are deduplicated.

## Usage

```text
/notify          Show status
/notify on|off   Enable or disable notifications
/notify test     Send a sample notification
```

## Configuration

`$PI_CODING_AGENT_DIR/notify.json`:

```json
{ "enabled": true, "banner": true, "bell": true }
```

`banner` controls desktop notifications; `bell` controls the terminal bell.

Ghostty and WezTerm use OSC 777; iTerm2 uses OSC 9. Other terminals fall back to `osascript` on macOS or `notify-send` on Linux. Fallback notifiers may require OS permission and do not necessarily focus the terminal when clicked.

If focus reporting is unavailable, the extension sends notifications regardless of focus.

## Dependencies and limitations

- Uses Pi's terminal-input, event, and lifecycle APIs.
- No third-party packages.
- macOS and Linux have native fallbacks. Other platforms require a terminal with supported OSC notifications; the bell still works where supported.
- Desktop delivery depends on terminal and OS notification settings.
