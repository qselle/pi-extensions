# prevent-sleep

Keeps the computer awake while Pi is actively running an agent turn. The lock is released when the turn settles, the extension is disabled, or Pi exits.

## Usage

```text
/prevent-sleep          Show status
/prevent-sleep on|off   Enable or disable it for the session
```

Disable the extension in `pi config` to keep it off permanently.

## Dependencies and limitations

| Platform | Command |
|---|---|
| macOS | `/usr/bin/caffeinate -i -w <pi-pid>` |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block … sleep infinity` |
| Other | No operation |

The macOS command prevents idle system sleep, not display sleep. The extension uses lifecycle events rather than a timer.

- Uses Pi's `agent_start` and `agent_settled` events.
- Requires `caffeinate` on macOS or `systemd-inhibit` on Linux.
- No third-party packages.
