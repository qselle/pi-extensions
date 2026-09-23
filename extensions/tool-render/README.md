# tool-render

Replaces Pi's built-in tool cards with compact headlines, bounded output, grouped exploration calls, and line-numbered diffs.

```text
• Ran command · Check the renderer tests
  │ bun test
  └ 12 pass  0 fail

• Edited src/auth.ts (+1 -1)
   40   export function add(a, b) {
   41 - return a - b
   41 + return a + b
```

## Usage

```text
/tool-render          Show status
/tool-render on|off   Save the setting; run /reload to apply it
```

This extension changes rendering. Execution and result details come from Pi's built-in definitions; Bash also accepts optional `purpose` display metadata. If `background-jobs` is enabled, bash uses its managed executor and keeps these compact cards. Cleanly completed foreground commands show their output and nonzero elapsed time; active or failed jobs and incomplete logs retain their IDs and status. Expand to see job cursors and all metadata. The tools use the active session directory after session changes.

### Command purpose

The model is asked to include a brief, factual purpose with each useful Bash
call, such as "Check the renderer tests" or "Find the session configuration".
This appears after the command status on the existing header, in normal text
color. It describes the intended action; the output below reports what actually
happened. The command panel stays separate and retains the exact shell source.

The optional `purpose` field is generated within the same tool call, with no
extra model request. It is not taken from Pi's thinking blocks and does not change
their visibility or native toggle. Calls without a purpose keep their usual
header; existing sessions are not retroactively annotated. Saved purposes render
again when a session is resumed. Captions remain one line, with an ellipsis when
space is tight; terminal controls, extra whitespace and excessive length are
removed from the display. Purpose metadata is stripped before command execution.
The model may omit it, and captions are limited to Bash commands.

Shell commands, edit/write diffs and expanded file reads use shared Shiki
highlighting with the `gruvbox-dark` theme. Its Gruvbox grammar colors distinguish
keywords, built-ins, strings, variables and comments in truecolor. Other themes
use Pi's native syntax colors. Every shell command sits below its neutral status
header in a softly shaded inset panel, with a quiet left gutter. The panel uses
`toolPendingBg` in every phase; errors color the status and diagnostic output,
not the whole command surface. Output aligns directly below without an extra
blank row or heavy box. Highlighting applies while running and after completion. Command text,
execution and source results are unchanged. Reload Pi once to apply an extension update.

Consecutive `read`, `grep`, `find`, and `ls` calls are grouped into one exploration block. Repeated reads of one file merge their ranges. Grouping is live-only and is not rebuilt after reload.

Running reads, searches, and writes appear immediately, with an accent-colored
action; completed rows become quiet and failures retain their error color.
Search rows include their directory and glob, and reserve space for match/file
counts when a long subject needs clipping. Counts exclude grep context and
continuation notices, empty results report zero, and bounded results are marked
`limited`. Read and directory targets stay clickable within groups. Read counts
include blank lines; requested read ranges remain visible for chunked reads.

Expanded exploration calls show their individual output, including calls hidden behind a grouped leader when collapsed. Output keeps the last 200 lines with an omitted-line count. Collapsed groups retain a failure diagnostic instead of replacing it with a successful read range. Command and edit/write errors show up to eight lines when collapsed and 200 when expanded.

`Ctrl+O` expands output. File targets use the shared helpers from [`hyperlinks`](../hyperlinks/). Enabling that extension is optional; it adds `/hyperlinks` mode controls and `/open-path`. Every rendered line is width-bounded; rendering errors fall back to a plain line.

Shell command lines wrap to the panel's inner width, including long tokens.
Collapsed commands show four visual rows, expanded commands up to 128, followed
by an omitted-row count when needed. Tabs display as four spaces; the executed
argument and saved source remain unchanged. Very narrow widths shed indentation
and the gutter. Other long output lines are clipped to terminal width. These cards
are a bounded preview; use the transcript or the tool's source/output artifact
when you need the complete content for copying.

## Configuration

The setting is stored in `$PI_CODING_AGENT_DIR/tool-render.json` as `{"enabled": false}` when disabled.

## Dependencies and limitations

Long or multiline shell commands wrap into a bounded block; expand it for more lines.

- Uses Pi's public extension, built-in tool-definition, syntax-highlighting, and rendering APIs.
- Uses the package's `shiki` dependency and shared [`lib/syntax.ts`](../../lib/syntax.ts)
  implementation. Each extension caches its own highlighter during interactive
  session startup and disposes it on shutdown. It retains foreground
  colors without clearing the diff backgrounds. Unsupported languages, parser
  budgets or initialization failure fall back to Pi's native highlighting.
- Shell highlighting uses a Bash grammar; embedded Python, JavaScript and other
  heredoc bodies are not guaranteed to be separately parsed. Commands over 16,000
  characters and native highlighting failures use plain text, retaining the normal preview limits.
- Expanded reads infer their grammar from the filename and highlight the existing
  bounded preview. Non-code files and errors keep their ordinary output colors.
- Uses shared link helpers in [`lib/links.ts`](../../lib/links.ts).
- Interactive TUI only; cross-platform.
- Pi reports a one-time startup warning for each intentionally overridden built-in tool.
- Compact `read` output omits inline image previews.
