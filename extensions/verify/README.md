# verify

Runs your project's own check after the agent edits a file, and appends the
failure to that edit's tool result — so the agent finds out it broke something on
the turn it broke it, instead of three turns later.

Silent when the check passes. Nothing configured means the extension does nothing.

## How it works

After every successful `edit` or `write`, the touched path is matched against
your configured checks. The first matching check runs, and on a non-zero exit its
output is appended to the tool result the model already reads:

```
● Edited extensions/verify/runner.ts

  verify: tests failed (exit 1)
  command: bun test 'extensions/verify'
  The edit was applied. This check ran afterwards and failed, so fix the cause
  instead of repeating the edit.

  1 failing
  runner.test.ts:104  expected true, received false
```

The text lands in the tool result itself, so the model sees the failure attached
to the exact edit that caused it, with no extra message in the conversation.

## Configuration

Project `.pi/verify.json`, falling back to `$PI_CODING_AGENT_DIR/verify.json`
(default `~/.pi/agent/verify.json`):

```json
{
  "checks": [
    { "name": "tests", "match": "extensions/**/*.ts", "command": "bun test {dir}", "timeoutMs": 60000 },
    { "name": "rust",  "match": ["**/*.rs"],          "command": "cargo check" }
  ],
  "spillTokenLimit": 2500
}
```

| Key | Meaning |
|---|---|
| `checks[].match` | Glob or list of globs against the repo-relative path. `**` crosses directories, `*` and `?` do not |
| `checks[].command` | Shell command. `{file}`, `{dir}`, `{files}` are substituted and shell-quoted |
| `checks[].name` | Label used in output and `/verify status`; defaults to `check N` |
| `checks[].timeoutMs` | Per-check timeout, default 60,000, capped at 10 minutes |
| `enabled` | Set `false` to keep the config but stop running it |
| `spillTokenLimit` | Approximate token budget for injected output, default 2,500 |

The first matching check wins. A project config replaces the global one rather
than merging, so a repo fully controls its own checks.

## Commands

| Command | Effect |
|---|---|
| `/verify` or `/verify status` | Show whether it is on, which config is in use, the checks, and the last result |
| `/verify off` / `/verify on` | Disable or enable for this session |
| `/verify run <path>` | Run the matching check for a path now, without editing anything |

## Design decisions

**Never marks the tool result as an error.** The edit *did* apply. Setting
`isError` would tell the agent its write was rejected, and it would re-apply the
edit or loop. The appended text says so explicitly: fix the cause, do not repeat
the edit.

**Silent on success.** A passing check appends nothing, so a clean run costs zero
tokens. The model only ever hears about verification when something is broken.

**Oversized output spills to a file.** Rather than truncating a noisy failure, the
full output is written to a temp file and only a bounded preview plus the path is
injected, so the agent can `read` the rest on demand. Truncation is the fallback
if the write fails. The budget is counted in approximate tokens, not bytes.

**Project config requires project trust.** `.pi/verify.json` is an executable
command; a cloned repo could otherwise ship `{"command": "curl … | sh"}` that
fires on the agent's first edit. Project config is only honored when
`isProjectTrusted()` is true, and `/verify status` says so when it was ignored.

**Cancellation is not a failure.** If you press Esc, the check is killed via the
turn's abort signal and nothing is injected, because the failure would be yours,
not the code's.

**Caching is per turn, per file.** Results are keyed by the command plus the
edited file's size and mtime, and cleared on every `turn_start`. A repeated
identical invocation is served from cache; a genuine new edit always re-runs.

## Limitations

- **One run per edited file.** Three edits under the same check in one turn run it three times. That is deliberate: coalescing would risk reporting a result that predates the later edits. Fine for a fast test command, noticeable for a slow one — scope `match` narrowly, or raise `timeoutMs` and accept the cost.
- **Shell-dependent.** Commands run through `$SHELL -c` (POSIX) or `cmd.exe /c` (Windows). Paths are quoted for the respective shell.
- **Not a linter of record.** It reports the exit code of whatever you configure; it does not parse or rank diagnostics.
- **This repo has no `tsconfig.json`**, so a bare `tsc --noEmit` reports false positives such as `Cannot find name 'process'`. Prefer `bun test {dir}` here.

## Dependencies

- **Runtime:** Pi's public extension API — `tool_result` (which can modify the result), `pi.exec`, commands, and `isProjectTrusted()`.
- **Depends on extensions:** None.
- **Third-party packages:** None.
- **Platforms:** macOS, Linux, and Windows.
