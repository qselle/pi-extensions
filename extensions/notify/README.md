# notify

Sends a desktop notification and terminal bell when a turn finishes or Pi needs questionnaire input.

Notifications are suppressed while the terminal is confirmed focused. Routine turn-complete notifications are also suppressed while an active [`goal`](../goal/) is continuing; questionnaire attention notifications remain available. A goal becoming blocked, stalled, budget-limited, or usage-limited sends one attention notification and suppresses the redundant turn-complete notification. Restoring an existing state stays quiet, and reload detaches the previous runtime's listeners. Identical notifications within five seconds are deduplicated.

A failed tool operation remains visible in the settled notification until the same tool and arguments succeed on retry. An unrelated successful read or shell command does not hide it. Failure tracking resets at the next agent run.

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

If focus reporting is unavailable or no actual report has arrived, the extension sends notifications regardless of focus. `/notify` reports `focus unknown` while waiting for the first report; declaring terminal support alone never suppresses alerts.

## Dependencies and limitations

- Uses Pi's terminal-input, event, and lifecycle APIs.
- No third-party packages.
- macOS and Linux have native fallbacks. Other platforms require a terminal with supported OSC notifications; the bell still works where supported.
- Desktop delivery depends on terminal and OS notification settings.
