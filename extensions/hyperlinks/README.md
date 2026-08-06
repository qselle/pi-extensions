# hyperlinks

Clickable file paths in the terminal, and the shared helper other extensions use
to make their own paths clickable.

Paths rendered by [`tool-render`](../tool-render/) and
[`file-changes`](../file-changes/) become OSC 8 hyperlinks: Cmd-click (or
Ctrl-click) `src/auth.ts` in a tool block and it opens in your editor, without
changing the visible width of anything.

## Commands

| Command | Effect |
|---|---|
| `/hyperlinks` | Show the current mode, whether links are active, and what terminal was detected |
| `/hyperlinks auto\|always\|never` | Change the mode for this session |
| `/open-path <path>` | Print a clickable link plus the resolved `file://` URI |

## Modes

| Mode | Behavior |
|---|---|
| `auto` (default) | Link when the terminal supports OSC 8 |
| `always` | Always emit links, e.g. for a terminal that is not detected correctly |
| `never` | Emit plain text |

`auto` declines to emit links when stdout is not a TTY, when `TERM` is unset or
`dumb`, and in Apple Terminal, which parses OSC 8 but prints the URL as literal
text. `NO_HYPERLINK` forces off and `FORCE_HYPERLINK` forces on, both taking
precedence over detection. Verified working in Ghostty, iTerm2, WezTerm, and
Kitty.

## Why the terminator matters

An OSC 8 opener has zero visible width, so width-aware truncation keeps it while
dropping the closing sequence. The result is an *unterminated* hyperlink, and
every line printed afterwards becomes part of that link. This is easy to hit:
pi's `truncateToWidth` does exactly that.

```ts
truncateToWidth(fileLink("src/some/long/path.ts", "/abs/path.ts"), 10, "…");
// -> "\x1b]8;;file:///abs/path.ts\x1b\\src/some/…"   ← link never closed
```

`closeDanglingLink()` repairs a line after fitting: it appends the missing
terminator, and strips a trailing opener if truncation landed inside the escape
sequence itself. Both `tool-render` and `file-changes` run every rendered line
through it.

## Exports for other extensions

```ts
import { hyperlinkPath, closeDanglingLink } from "../hyperlinks/link.ts";

// Link after fitting, so the visible width is unchanged.
const shown = truncateToWidth(file.path, width, "…");
const row = hyperlinkPath(shown, file.path, ctx.cwd);

// Repair any line that gets width-fitted after linking.
return lines.map((line) => closeDanglingLink(truncateToWidth(line, width, "")));
```

| Export | Purpose |
|---|---|
| `hyperlinkPath(display, path, cwd?)` | Wrap display text as a link to `path`; returns `display` unchanged when disabled. An absolute URI is passed through instead of being resolved as a path |
| `hyperlinkUrl(display, url)` | Mode-aware label link to any URI (`https:`, `mailto:`, `ssh:`, editor schemes) |
| `hasUriScheme(value)` | True for absolute URIs; false for paths and Windows drive letters |
| `link(display, uri)` | Wrap display text as a link to an arbitrary URI, ignoring mode |
| `fileUri(absPath)` | `file://` URI, percent-encoded, POSIX separators |
| `toAbsolutePath(path, cwd?)` | Resolve a display path for linking |
| `closeDanglingLink(text)` | Repair a line truncated mid-link |
| `hasDanglingLink(text)` | True when a line opens more links than it closes |
| `hyperlinksEnabled()` / `supportsHyperlinks()` | Mode-aware and raw terminal capability checks |
| `setHyperlinkMode(mode)` / `getHyperlinkMode()` | Read or change the mode |

`link()` deliberately ignores the mode so callers that always want an escape
(such as `tool-render`'s `fileLink`) keep working; `hyperlinkPath()` and
`hyperlinkUrl()` are the mode-aware entry points.

## Non-file URLs

OSC 8 is scheme-agnostic, so labels can point anywhere:

```ts
hyperlinkUrl("PR #123", "https://github.com/you/repo/pull/123");
hyperlinkUrl("file in Cursor", "cursor://file/abs/path.ts");
```

Most modern terminals already auto-detect a bare `https://…` in output and make
it clickable on their own. The reason to use OSC 8 for http is a *label*: showing
`PR #123` while linking elsewhere, which plain autodetection cannot do.

## Configuration

Optional `$PI_CODING_AGENT_DIR/hyperlinks.json` (defaults to
`~/.pi/agent/hyperlinks.json`):

```json
{ "mode": "auto" }
```

Invalid values and unreadable files fall back to `auto`.

The mode is process-global state shared with the extensions that render links, so
it is applied when the session starts and handed back on `session_shutdown`.
That way a mode configured for one project does not linger after `/resume` enters
a project that configures none. Setting the mode with `/hyperlinks` takes
ownership, and shutdown leaves that choice untouched.

## Dependencies and limitations

- **Runtime:** Pi's public extension and command APIs.
- **Depends on extensions:** None. `tool-render` and `file-changes` import this extension's `link.ts`.
- **Third-party packages:** None.
- **Platforms:** macOS, Linux, and Windows. Windows paths are normalized to POSIX separators in the URI.
- **Editor:** Clicking hands the `file://` URI to the terminal, which delegates to the OS handler. Which editor opens is a terminal and OS setting, not something this extension controls.
- **Limitation:** Line and column anchors are not encoded; the link opens the file, not a specific line.
