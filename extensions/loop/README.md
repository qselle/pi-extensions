# loop

Runs a prompt repeatedly while the current Pi session is open.

## Usage

```text
/loop                                      Start the default model-paced loop
/loop 15m                                  Run the default prompt every 15 minutes
/loop 5m <prompt>                          Run a prompt every 5 minutes
/loop <prompt>                             Let the model choose each delay
/loop status
/loop pause|resume|stop <id>
/loop stop all
```

Fixed and model-paced loops run once immediately. A model-paced loop uses `loop_schedule` to select the next delay from 1 to 60 minutes. If it omits a delay twice, the loop stops after one 20-minute fallback.

Agent tools:

- `loop_schedule` sets the next model-paced delay.
- `loop_stop` stops the loop that owns the current turn.
- `get_loops` lists loop state and wake times.

Only `/loop` can create a loop.

Limits:

- 8 active or paused loops per session.
- 25 iterations or 12 hours per loop.
- Fixed intervals from 1 minute to 1 hour.
- Pauses at 90% context usage, on interruption, or on provider failure.
- Due work waits for Pi to be idle and coalesces missed intervals.

Loop state survives reload and resume, but nothing runs while Pi is closed. A wakeup does not grant new authority for external or destructive actions.

## Configuration

The default prompt is loaded from the first valid source:

1. trusted project `.pi/loop.md`
2. `$PI_CODING_AGENT_DIR/loop.md`
3. the built-in maintenance prompt

Prompt files are re-read at each wake. Empty files, symlinks, and files over 25,000 characters are ignored.

## Dependencies and limitations

- Uses Pi's public extension API and host-provided `typebox`.
- No third-party runtime packages or OS services.
- Persistent TUI and RPC sessions only.
- Uses in-process wall-clock timers; sleep and closed sessions delay execution.
