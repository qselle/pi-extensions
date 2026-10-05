# tool-render

Replaces Pi's built-in tool cards with compact headlines, bounded output, grouped exploration calls, and line-numbered diffs.

```text
• Ran command · Check the renderer tests · ✓ in 3s
  │ bun test
  └ 12 pass  0 fail

• Command failed · Run the parser tests · ✗ exit 2 in 12s
  │ bun test parser
  └ 1 fail

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

This extension changes rendering. Execution and result details come from Pi's built-in definitions; tools also accept optional `purpose` display metadata. Two results gain display details: `write` saves a diff when it replaces a file, and native `bash` records `exitCode` and `durationMs`. If `background-jobs` is enabled, bash uses its managed executor and keeps these compact cards. Cleanly completed foreground commands show only their output below the headline; active or failed jobs and incomplete logs retain their IDs and status. Expand to see job cursors and all metadata. The tools use the active session directory after session changes.

### Command status

Settled bash headlines end with `✓` or `✗` and the failure reason (`exit 2`,
a signal, `timed out`, `aborted`), followed by the elapsed time (`in 3s`).
Runs under one second show no time. On narrow terminals the caption is clipped
before the status. Running commands show a live elapsed time that updates when
Pi repaints; no timer of this extension's own drives it. A yielded managed job
reads `running` until its completion refreshes the card.

Managed results are read from `details`: `exitCode`, `status`, `signal`,
`durationMs` or `startedAt`/`endedAt`. When these are missing, the saved
summary line (`× Shell command · failed · 3s · exit 1`) or Pi's
`Command exited with code N` notice supplies the status. Older native results
without a recorded duration show the status alone.

### Write and edit cards

While the model streams a write or edit, its card reads `Writing <path> · N lines`
or `Editing <path> · N edits`, and keeps that headline while the change runs. The
result replaces it with the outcome and `(+added -removed)` counts.

When `write` replaces an existing text file, the card diffs against the previous
content. The previous file is read inside Pi's per-file mutation queue, just
before the write. The result saves a bounded unified patch (up to 400 rows) with
the full added and removed counts. New files, and files over 512 KiB or 5,000
lines before or after the change, show their content as added; binary files do
too.

### Action purpose

Tools accept an optional brief, factual purpose, such as "Check the renderer
tests" or "Find the session configuration". Bash, reads, edits, writes, directory
listings, and searches expose this field in their ordinary tool schemas. The
guidance asks for a purpose on every bash, edit and write call, and allows
omitting it only for self-evident reads and searches. The field stays optional,
so a call without it never fails validation.
This appears after the action on the existing header, in normal text
color. It describes the intended action; the output below reports what actually
happened. The command panel stays separate and retains the exact shell source.

The optional `purpose` field is generated within the same tool call, with no
extra model request. It is not taken from Pi's thinking blocks and does not change
their visibility or native toggle. Calls without a purpose keep their usual
header; existing sessions are not retroactively annotated. Saved purposes render
again when a session is resumed. Calls saved with a `reasoning` argument instead
show it as their caption; `purpose` wins when both are present. Captions remain one line, with an ellipsis when
space is tight; terminal controls, extra whitespace and excessive length are
removed from the display. `purpose` and `reasoning` are stripped before native
execution, preserving exact commands, paths, queries, and write content. Native
file-tool guidelines are unchanged; the schema descriptions supply the guidance.

Exploration rows show intent beside their target when space permits. A common
purpose for a whole group appears once in its heading. Repeated reads with
different purposes remain distinct; matching purposes keep range coalescing.
Narrow layouts prioritize targets and result counts. Captions that only repeat a
target are omitted. Managed job controls expose the same field through
[`background-jobs`](../background-jobs/).

Shell commands, edit/write diffs and expanded file reads use shared Shiki
highlighting with the `gruvbox-dark` theme. Its Gruvbox grammar colors distinguish
keywords, built-ins, strings, variables and comments in truecolor. Other themes
use Pi's native syntax colors. Every shell command sits below its neutral status
header in a softly shaded inset panel, with a quiet left gutter. The panel uses
`toolPendingBg` in every phase; errors color the status and diagnostic output,
not the whole command surface. Output aligns directly below without an extra
blank row or heavy box. Highlighting applies while running and after completion. Command text,
execution and source results are unchanged. Reload Pi once to apply an extension update.

Consecutive `read`, `grep`, `find`, and `ls` calls are grouped into one exploration
block. Repeated reads of one file merge their ranges. Collapsed groups show up to
five rows, keeping failures and running steps ahead of recent successful work.
A quiet omission row reports the remaining steps and the configured expansion
key; any omitted failures or running steps are counted explicitly. Failed calls
also retain their individual diagnostic below the group.

Grouping is restored after reload, resume, tree navigation, and compaction from
the same saved entries Pi displays. This also works for older sessions, without
adding metadata or changing stored results. Calls with missing, duplicate, or
mismatched results and aborted assistant messages stay standalone. Compacted-away
calls do not own groups for the surviving transcript.

Running reads, searches, and writes appear immediately, with an accent-colored
action; completed rows become quiet and failures retain their error color.
Search rows include their directory and glob, and reserve space for match/file
counts when a long subject needs clipping. Counts exclude grep context and
continuation notices, empty results report zero, and bounded results are marked
`limited`. Read and directory targets stay clickable within groups. Read counts
include blank lines; requested read ranges remain visible for chunked reads.
Long file targets shorten their middle while preserving the filename and full
clickable destination, so similar directory prefixes remain distinguishable.

Expanded exploration calls show their individual output, including calls hidden behind a grouped leader when collapsed. Output keeps the last 200 lines with an omitted-line count. Collapsed groups retain a failure diagnostic instead of replacing it with a successful read range. Command and edit/write errors show up to eight lines when collapsed and 200 when expanded.

`Ctrl+O` expands output. File targets use the shared helpers from [`hyperlinks`](../hyperlinks/). Enabling that extension is optional; it adds `/hyperlinks` mode controls and `/open-path`. Every rendered line is width-bounded; rendering errors fall back to a plain line.

Shell command lines wrap to the panel's inner width, including long tokens.
Collapsed commands show four visual rows, expanded commands up to 128, followed
by an omitted-row count when needed. Tabs display as four spaces; the executed
argument and saved source remain unchanged. Very narrow widths shed indentation
and the gutter. Collapsed output and diff lines are clipped to terminal width;
expanded output, file reads and diffs wrap long lines, with diff continuations
aligned under the code column. These cards are a bounded preview; use the transcript or the tool's source/output artifact
when you need the complete content for copying.
Omission rows offer expansion only while it can reveal more content; after the
expanded limit, they say `preview limit`. Diffs follow the same convention.

### Render cache

Pi repaints every card on each frame. Settled cards build their rows once per
width (up to four widths) and repaint them byte-identically; command and diff
highlighting runs once per card. Pi recreates a card when its arguments, result,
expansion or theme change. Group membership, syntax highlighter readiness and the
hyperlink mode are also checked, so changes there rebuild affected cards. Running
and streaming cards rebuild on every frame.

### Saved-history benchmark

Run `bun extensions/tool-render/history.benchmark.ts` from the repository. It
reopens 1,000 saved exploration calls through Pi's native session manager and
renders native tool components in both 20 groups and one unusually large group.
It also paints 800 settled bash and edit cards with Shiki highlighting.
It reports restore, repaint, resize, expansion, row counts and memory deltas.
Timings are informational and exclude terminal I/O.
Collapsed followers use a constant-time membership check; only group leaders
build grouped rows, while failed followers keep their individual diagnostics.
On an Apple-silicon laptop, a repaint of the 800 highlighted cards takes about
0.3 ms with the cache (116 ms without), and a resize cycle about 10 ms (128 ms).

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
- Pi owns inline image previews, including compact and restored `read` cards.
  Previews follow its image visibility preference and terminal capabilities;
  this renderer does not add a duplicate image. Pi 1.0 does not expose a
  per-result switch for lazy previews on expansion. Embedded image content,
  session exports, and image-history retrieval remain unchanged.
