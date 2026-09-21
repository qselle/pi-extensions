# transcript

A searchable, scrollable view of saved conversation history, including live
assistant output and messages from before context compaction.

## Usage

```text
/transcript                 Current branch, following the latest messages
/transcript <query>         Current branch, jump to a matching line
/transcript all             Every saved branch, in storage order
/transcript all <query>     Search across all saved branches
Ctrl+Shift+T                Open the current branch
```

Use your configured arrow and page-navigation keys to scroll, Home to jump to
the beginning, and End to resume following new output. `/` opens search; Enter
keeps the query and returns to navigation, while Escape cancels that search edit.
`n` and `N` move between occurrences, including repeated matches on one row.
Search is case-insensitive and treats runs of whitespace as one space. Phrases
and long words can span visual wraps; every row occupied by the selected match
is highlighted. Resizing retains the selected occurrence. `t` toggles thinking
text (hidden by default). `q` or your
configured cancel key closes the viewer without touching the editor draft.

Assistant Markdown and code use Pi's native renderer. Tool calls, results, shell
output, and compaction summaries have distinct labels; failed calls use the error
color. Images appear as placeholders, never base64 payloads. Hidden extension
context and internal state entries are excluded. The viewer does not modify
history, submit prompts, or write transcript exports to disk.

The panel has a visible frame and padded rows spanning the terminal width, so
fragments of the underlying conversation cannot appear beside its body. The same
frame is used by schedule, monitor and doctor reports.

Keyboard hints adapt to the available width. Close, search and basic scrolling
take priority; wider panels also show match navigation, paging and mode controls.
All bindings remain available when their hint does not fit.

## Dependencies and limitations

- Pi 0.87.0 public session, event, Markdown, and TUI APIs; no runtime packages.
- Shares keyboard-hint formatting with `history-search`; that extension need not
  be enabled. Interactive TUI only; cross-platform.
- All-branches mode is chronological storage order, not a session-tree graph.
- Search maps logical text onto native rendered rows. It does not join separate
  source lines or messages into invented phrases. Markdown uses a second, wider
  native render while searching; tables and other layouts that cannot be mapped
  exactly fall back to matching within individual rendered rows. The wider render
  is skipped above 4,096 columns or a one-million-character work estimate.
- New output is followed only until you manually scroll. End resumes following.
  Streaming redraws are coalesced to at most ten per second; no idle timers run.
- Rendered blocks are cached between scrolls and reused when their text and width
  are unchanged. Search indexes are built only when searching and reused across
  query edits and scrolling. Large histories still require memory proportional
  to their text.
- Session replacement closes the viewer and releases its refresh timer.
