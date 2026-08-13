# verify

Runs a configured project check after a successful `edit` or `write` and appends failures to that tool result. Passing checks are silent.

## Usage

```text
/verify             Show config, checks, and the last result
/verify status      Show config, checks, and the last result
/verify on|off      Toggle checks for the current session
/verify run <path>  Run the matching check without editing
```

Failed verification does not mark the edit itself as failed. Large output is written to a temporary file and the tool result receives a bounded preview and path. Cancellation kills the check without reporting a code failure.

Results are cached per turn, command, and file state. A later edit changes the cache key and runs the check again.

## Configuration

Use trusted project `.pi/verify.json`, falling back to `$PI_CODING_AGENT_DIR/verify.json`:

```json
{
  "checks": [
    {
      "name": "tests",
      "match": "extensions/**/*.ts",
      "command": "bun test {dir}",
      "timeoutMs": 60000
    }
  ],
  "spillTokenLimit": 2500
}
```

- `match` is a glob or list of globs against the repository-relative path.
- `command` may use shell-quoted `{file}`, `{dir}`, and `{files}` placeholders.
- The first matching check runs.
- `timeoutMs` defaults to 60 seconds and is capped at 10 minutes.
- `enabled: false` disables all checks.
- Project configuration replaces global configuration and is ignored unless Pi trusts the project.

## Dependencies and limitations

- Uses Pi's public tool-result, command, trust, and process-execution APIs.
- No third-party packages.
- Supports macOS, Linux, and Windows. Commands run through `$SHELL -c` on POSIX and `cmd.exe /c` on Windows.
- One check runs after each matching edited file; several edits can run the same check several times.
