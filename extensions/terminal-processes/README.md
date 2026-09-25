# terminal-processes

Runs foreground commands in visible sibling [Herdr](https://herdr.dev/) panes while Pi keeps focus. Use it for development servers, test watchers, log tails, and interactive programs that should keep running after Pi reloads or exits.

## Usage

The `terminal_process` tool appears only in a Herdr-managed Pi TUI. It provides these explicit actions:

| Action | Parameters | Behavior |
| --- | --- | --- |
| `start` | `command`, optional `label`, `direction` | Opens a sibling pane at Pi's working directory and submits the exact command plus Enter. |
| `list` | none | Lists this session's saved pane records and whether command submission was acknowledged. |
| `read` | `pane_id`, optional `lines` | Reads recent plain output; defaults to 120 rows, with a visible-snapshot fallback. |
| `status` | `pane_id` | Shows current foreground process names and PIDs, when Herdr reports them. |
| `input` | `pane_id`, optional `text`, `press_enter` | Sends literal text and optionally Enter together. Enter defaults to true; omitting text permits Enter alone. |
| `interrupt` | `pane_id` | Sends Ctrl+C, leaving the pane open. |

For example, ask Pi to “start the development server in a visible terminal pane” or “read the last 80 lines from that terminal.” Start commands should stay in the foreground. Normal Bash execution is never redirected automatically.

An explicit `direction` can be `right` or `down`. Otherwise the first split follows the current pane proportions, opening below a narrow pane; later starts alternate directions. No action closes panes or changes focus. Reloading, resuming, and navigating the session tree restore ownership without restarting commands. Forked and unrelated Pi sessions cannot control inherited panes.

`list` reports saved ownership and submission state, not live process state. Use `status` and `read` for current information. A command whose acknowledgement was lost remains marked **launch unconfirmed**; inspect its pane before retrying. Cancellation cannot undo an action Herdr has already accepted.

Output is limited to 2,000 lines and 50 KiB, with a 1 MiB socket-response ceiling. `input` results and renderers do not echo submitted text; process status omits argv and command lines. Tool arguments remain in Pi's transcript, and a terminal can echo input into subsequent `read` output, so this is not a secret-input channel.

## Configuration

No extension configuration file or extra dependency is needed. Herdr supplies `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`. The tool stays inactive in RPC/JSON mode, child agents, or outside Herdr.

Ownership uses Pi custom entries outside model context. It is scoped to the exact Pi session ID, Herdr socket instance, and terminal identity. A saved Pi session is required before `start`; Pi normally saves it when the assistant first responds. The extension never edits Herdr configuration.

## Dependencies and limitations

- Uses Pi's public extension API, Node built-ins, and the existing repository output/purpose helpers. No added packages, daemon, or CLI subprocess.
- Supports macOS and Linux Unix sockets. Windows named pipes are intentionally inactive because this implementation validates Unix socket ownership and instance identity.
- Requires Herdr's public `pane.get`, `pane.layout`, `pane.split`, `pane.rename`, `pane.send_input`, `pane.read`, and `pane.process_info` methods. Wire shapes were checked against the [official socket documentation](https://herdr.dev/docs/socket-api/) and [public schema/source](https://github.com/herdrdev/herdr/blob/21d0ce60267ad947c081d3d3fba401c859f06dd2/src/api/schema/panes.rs). Command submission uses the same atomic text-plus-Enter method as [`pane run`](https://herdr.dev/docs/cli-reference/).
- Processes belong to Herdr and survive Pi shutdown while that Herdr terminal remains alive. They do not survive every Herdr/server/shell failure. There is no exit-code tracking or automatic restart.
- Replaced sockets and mismatched terminal identities are refused, even if a pane ID is reused. After a Herdr server handoff or socket replacement, use manual terminal controls. Moved panes work only while Herdr still resolves their saved ID to the same terminal.
- Herdr has no conditional identity-and-input operation. Identity is checked immediately before control, but a concurrent external pane replacement can still race the write. Socket mutations are never retried automatically.
- A cancellation, disconnect, or persistence failure after a split can leave an empty pane open. A command may already have been accepted when acknowledgement fails. The extension deliberately does not close panes, undo input, or replay saved commands.
- Tests use disposable local socket servers and native Pi sessions; they do not open live Herdr panes.
