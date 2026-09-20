# prevent-sleep

Keeps your Mac awake while Pi is actively running an agent turn. The lock is released when the turn settles, the extension is disabled, or Pi exits. Linux and other platforms are a no-op: no helper process, lifecycle handlers, or command are registered.

## Usage

```text
/prevent-sleep          Show status
/prevent-sleep on|off   Enable or disable it for the session
```

Disable the extension in `pi config` to keep it off permanently.

Status distinguishes a helper that is starting, a running helper, and a helper that failed or exited unexpectedly. Startup failure is not reported as idle. A running process indicates that the helper is alive, not an independent measurement of the OS sleep assertion. Retry with `/prevent-sleep on` while working, or let the next agent run try again; there is no automatic retry loop.

Session start releases any previous helper and resets activity. Shutdown prevents late activity events from acquiring a new helper. Late exits from an older helper cannot change the replacement helper's status.

## Dependencies and limitations

| Platform | Command |
|---|---|
| macOS | `/usr/bin/caffeinate -i -w <pi-pid>` |
| Linux and other platforms | No operation |

The macOS command prevents idle system sleep, not display sleep. The extension uses lifecycle events rather than a timer.

Live macOS validation checks the test helper's `PreventUserIdleSystemSleep`
assertion through `pmset`, then verifies release on settlement, disable, session
reset and shutdown. Run `PI_TEST_SLEEP_ASSERTION=1 bun test
extensions/prevent-sleep/runtime.integration.test.ts` to repeat this opt-in test.
It briefly holds an assertion, cleans up its own helpers, and does not change
power settings. Normal test runs skip it. This verifies the OS assertion, not a
forced sleep/wake cycle. Linux sleep inhibition is intentionally out of scope.

- Uses Pi's `agent_start` and `agent_settled` events.
- Requires `caffeinate` on macOS; no Linux dependencies.
- No third-party packages.
