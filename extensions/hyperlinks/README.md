# hyperlinks

Adds OSC 8 links to terminal paths and provides link helpers used by other extensions.

## Usage

```text
/hyperlinks                    Show mode and terminal detection
/hyperlinks auto|always|never  Change mode for the current process
/open-path <path>              Print a link and its resolved file:// URI
```

The main helpers are `hyperlinkPath()` for mode-aware file links, `hyperlinkUrl()` for other URI schemes, and `closeDanglingLink()` for repairing lines truncated after an OSC 8 opener. See [`link.ts`](link.ts) for the full export list.

File targets percent-encode literal `#`, `?`, spaces and control characters. Windows drive and UNC paths produce proper file URIs, and home-relative paths expand before linking. Malformed raw URL targets containing spaces or terminal control characters remain plain display text.

## Configuration

`auto` is the default. It disables links outside a TTY, for `TERM=dumb`, and in Apple Terminal. `NO_HYPERLINK` forces links off; `FORCE_HYPERLINK` forces them on.

Optional `$PI_CODING_AGENT_DIR/hyperlinks.json`:

```json
{ "mode": "auto" }
```

Configured modes are reapplied on session start and released before the next session's configuration is loaded. Repeated starts preserve the original mode for shutdown restoration. A mode explicitly chosen with `/hyperlinks` remains owned by the user.

## Dependencies and limitations

- Uses Pi's public extension and command APIs; no third-party packages.
- Used by [`tool-render`](../tool-render/) and [`file-changes`](../file-changes/).
- Works on macOS, Linux, and Windows when the terminal supports OSC 8. URI and detection tests do not replace a live click-through check in the user's terminal.
- Clicking delegates the URI to the terminal and OS. This extension does not choose the editor or encode line and column positions.
