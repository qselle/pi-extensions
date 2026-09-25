# reload-all

Reload extensions, themes, skills and other Pi resources across the participating
top-level Pi terminals on this machine.

## Usage

```text
/reload-all          Broadcast a reload
/reload-all status   Inspect the latest broadcast
```

The command itself authorizes the broadcast. Each session waits until Pi reports
full idle, has no queued messages, and has no active extension dialog. Streaming,
tool work, compaction, retry and queued continuations keep it waiting. It never
interrupts or signals a process. Sessions started after the broadcast are excluded.
RPC, print and child-agent sessions do not participate.

After installing this extension, run `/reload` once or restart Pi in **each**
existing terminal. An already-running process cannot receive broadcasts until
it has loaded the extension. Subsequent updates can use `/reload-all`.

### Status and retries

A broadcast snapshots up to 256 registered terminal runtimes. `status` reports
`waiting`, `dispatching`, `requested`, `applied`, `failed`, `unresponsive`, or
`missing` counts. `dispatching` means the private command was submitted but has
not reached its handler. `requested` means a session called Pi's reload API;
`applied` requires the newly
loaded extension runtime to acknowledge the request with a different runtime
nonce. A resolved API call alone is not reported as success.

If Pi refuses a reload without replacing the runtime, the session remains waiting
and retries at safe idle boundaries after one then five seconds. After three
unconfirmed attempts it stops and reports failure. Exceptions stop immediately.
Fix the problem and send a new `/reload-all` broadcast to retry. Duplicate command
names also stop that session; remove the duplicate extension and bootstrap it with
`/reload`. Internal coordination forms are intercepted if native command dispatch
cannot resolve them, so they do not become model input.

Pi's send-user-message API does not return asynchronous dispatch failures. An
unconfirmed dispatch becomes failed after ten continuously idle seconds; busy
work, queued messages and dialogs reset that timer. A late command cannot apply
after its dispatch claim expires. A runtime replaced outside the handshake is
reported missing from the original snapshot, rather than left waiting forever.

Suspended terminals remain in the snapshot and can reload when they resume.
After 20 seconds without a heartbeat they appear `unresponsive`; this is not a
claim that their process died. Registrations untouched for seven days are pruned
when inspecting or broadcasting. Broadcasts also expire after seven days. A normal
quit removes that runtime's registration. A PID reused by another process cannot
inherit a request because its process nonce differs.

## Configuration

By default, state is stored under the operating system's temporary directory in
`qselle-pi-reload-<uid>-<machine-hash>/`. The registry contains only PIDs, random
identity/runtime tokens, timestamps and reload states; no conversation content,
paths, titles or credentials.

Set `PI_RELOAD_ALL_DIR` to an absolute directory to create an isolated coordination
group. Every participating terminal in that group must use the same directory.
Tests and synthetic previews should use a fresh temporary directory. Coordination
directories must be owned by the current user and are restricted to mode `0700`;
records use `0600`. Symbolic links, foreign-owner or nonprivate records, malformed
identities and oversized files are refused. Broadcast writes use an atomic rename.
If capacity is exceeded, the broadcast fails explicitly instead of choosing a
partial set of sessions. Registry scans stop after 1,024 directory entries.

## Dependencies and limitations

- Uses Pi's public extension, command, idle and UI-prompt lifecycle APIs, plus
  Node built-ins. No additional dependencies or system-prompt changes.
- macOS and Linux/POSIX hosts with reliable file ownership and atomic rename.
  Windows is not supported. Keep the override on a local filesystem.
- Active dialogs are detected through Pi's public extension UI-prompt events.
  Native screens that do not emit those events cannot be identified by this API.
- The replacement-runtime acknowledgement proves the coordination extension
  restarted. It does not certify that every other extension loaded successfully;
  inspect Pi's own reload diagnostics for resource errors.
- Only the latest broadcast is retained. A newer broadcast supersedes an earlier
  one that some sessions were still waiting to apply.

Verification: `bun test extensions/reload-all`. Native tests use two isolated Pi
session runtimes, real command resolution and `session.reload()`, without model
requests or broadcasts to other user terminals.
