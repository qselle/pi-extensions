# rewind

Return to an earlier user prompt by forking the conversation and restoring its
text to the editor. The original session remains available in Pi's session list.

## Usage

```text
/rewind           Searchable prompt picker, newest first
/rewind <query>   Filter prompt previews
/rewind last      Immediately fork before the latest user prompt
/undo             Alias for /rewind
```

Use the configured selection keys to choose a prompt; Enter forks and restores
the full text for editing without sending it. Escape cancels and leaves the
current editor draft untouched. Selecting a prompt replaces the editor draft.
Repeated identical prompts remain distinct choices, identified by turn number.
Search covers the first 500 characters of each prompt preview.

Rewind changes conversation history only: it does **not** undo edits, shell
commands, commits, or other side effects. The picker states that files stay
unchanged. Active runs and queued messages must finish or be cancelled before
rewinding. If the session changes while the picker is open, choose again.

## Dependencies and limitations

- Pi 0.87.0 public fork/session/editor APIs; interactive TUI only; cross-platform.
- Reuses this package's `history-search` picker and text extraction helpers.
  The history-search extension does not need to be enabled.
- No third-party runtime packages or configuration files.
- Only user messages on the active branch are offered. Hidden extension
  continuation messages, tool output, and other branches are excluded.
- Pi's editor API restores text, not image attachments. Image counts appear in
  the picker and the new session warns you to reattach images before sending.
- Fork cancellation by another extension is honored. Fresh session context is
  used after replacement, so stale contexts cannot write into the old runtime.
