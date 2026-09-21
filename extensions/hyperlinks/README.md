# hyperlinks

Adds OSC 8 links to terminal paths and provides link helpers used by other extensions.

## Usage

```text
/hyperlinks                    Show mode and terminal detection
/hyperlinks auto|always|never  Change mode for the current process
/open-path <path>              Print a link and its resolved file:// URI
```

The main helpers are `hyperlinkPath()` for mode-aware file links, `hyperlinkUrl()` for other URI schemes, and `closeDanglingLink()` for repairing lines truncated after an OSC 8 opener. See [`lib/links.ts`](../../lib/links.ts) for the helpers.

File targets percent-encode literal `#`, `?`, spaces and control characters. Windows drive and UNC paths produce proper file URIs, and home-relative paths expand before linking. Malformed raw URL targets containing spaces or terminal control characters remain plain display text.

## Configuration

`auto` is the default. It disables links outside a TTY, for `TERM=dumb`, and in Apple Terminal. `NO_HYPERLINK` forces links off; `FORCE_HYPERLINK` forces them on.

Optional `$PI_CODING_AGENT_DIR/hyperlinks.json`:

```json
{ "mode": "auto" }
```

Configuration is loaded on session start. A mode chosen with `/hyperlinks` overrides it for the current process.

## Dependencies and limitations

- Uses Pi's public extension and command APIs; no third-party packages.
- Used by [`tool-render`](../tool-render/) and [`file-changes`](../file-changes/).
- Works on macOS, Linux, and Windows when the terminal supports OSC 8.
- Clicking delegates the URI to the terminal and OS. This extension does not choose the editor or encode line and column positions.
