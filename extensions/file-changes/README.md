# file-changes

A passive card that summarizes files changed by Pi's built-in `edit` and `write` tools. It appears in the shared workflow overlay while an agent run is active and keeps the completed run visible until the next run starts.

```text
╭ Changed files · live ─────────────────────────────╮
│ + src/new-route.ts                           +24  │
│ ~ src/server.ts                         +7 -3  │
│                                                  │
│ 2 files  +31  -3                                │
╰──────────────────────────────────────────────────╯
```

`+` marks a newly created file and `~` marks a modified file. Long paths retain their filename, counts align on the right, and additional files collapse into a compact overflow row. The card hides on small terminals or when the active/last run changed no files.

## Commands

```text
/file-changes              Toggle the card
/file-changes toggle       Toggle the card
/file-changes show|hide    Show or hide the card
/file-changes status       Report visibility and the tracked file count
/overlay                   Toggle the complete workflow overlay
Ctrl+Shift+O               Toggle the complete workflow overlay
```

Visibility resets when extensions reload. There is no separate configuration file.

## Tracking model

The extension captures each file before its first successful mutation in an agent run and compares that baseline with its latest contents. Counts are net additions and removals for the run, so reverting a file removes it from the card instead of accumulating obsolete edit counts.

When the agent settles, the summary is saved as a non-context session entry. Reloading, resuming, or navigating the session tree restores the latest summary on that active branch. A later run with no file changes stores an empty summary so stale results do not return after reload.

## Dependencies and limitations

- **Runtime:** Pi's public extension, tool-event, session, and TUI APIs.
- **Depends on extensions:** [`overlay-stack`](../overlay-stack/).
- **Third-party packages or executables:** None.
- **Tracked mutations:** Successful local built-in `edit` and `write` calls only.
- **Not tracked:** Changes made through `bash`, `!` commands, custom mutation tools, remote tool backends, or external programs.
- **Display:** Interactive TUI only. The card is responsive and requires a terminal at least 72 columns wide and 12 rows high.
