# prevent-sleep

Keeps your Mac awake while Pi is actively running an agent turn. The lock is released when the turn settles, the extension is disabled, or Pi exits. Linux and other platforms are a no-op: no helper process, lifecycle handlers, or command are registered.

## Usage

```text
/prevent-sleep          Show status
/prevent-sleep on|off   Enable or disable it for the session
```

Disable the extension in `pi config` to keep it off permanently.

Status distinguishes a helper that is starting, a running helper, and a helper that failed or exited unexpectedly. Startup failure is not reported as idle. A running process indicates that the helper is alive, not an independent measurement of the OS sleep assertion. Retry with `/prevent-sleep on` while working, or let the next agent run try again; there is no automatic retry loop.

## Dependencies and limitations

| Platform | Command |
|---|---|
| macOS | `/usr/bin/caffeinate -i -w <pi-pid>` |
| Linux and other platforms | No operation |

The macOS command prevents idle system sleep, not display sleep. The extension uses lifecycle events rather than a timer.

To check the OS assertion and cleanup on macOS, run:

```bash
PI_TEST_SLEEP_ASSERTION=1 bun test extensions/prevent-sleep/runtime.integration.test.ts
```

This opt-in test briefly prevents idle sleep and releases its helpers afterward.

- Uses Pi's `agent_start` and `agent_settled` events.
- Requires `caffeinate` on macOS; no Linux dependencies.
- No third-party packages.
