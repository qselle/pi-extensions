# context-journal

Branch-local working notes and retrieval of older session messages. Disabled by
default; use [`memory`](../memory/) for notes shared across sessions.

## Usage

```text
/context-journal on       Enable tools and notes in model requests
/context-journal off      Disable tools/injection, retaining notes
/context-journal status   Show state and storage limits
/context-journal reset    Roll over while idle, after saving notes
```

Settings and note versions follow the session branch through resume and tree
navigation. `/handoff new` also transfers journal state.

| Tool | Purpose |
|---|---|
| `context_notes` | List, read, write (replace a key), or delete notes |
| `context_history` | Search text on the current branch, including before compaction |
| `context_budget` | Read Pi's context estimate and checkpoint budget |
| `context_rollover` | Request fresh context from saved notes, without a generated summary |

Notes are included in each model request. Record the objective, constraints,
decisions, evidence, and unfinished work. Keys allow 1–64 letters, digits, dots,
underscores, or hyphens. Limits: 32 keys, 4,000 characters per value, 16,000 total.
Changes take effect on the next request; deleting a note leaves older versions
in the session file and backups.

History search is literal and case-insensitive, newest first. Omit `query` for
recent text; pass `nextBefore` as `before` for older results. It returns up to
20 matches, with 2,000 characters per excerpt and 12,000 combined, plus headers.
It excludes reasoning, images, custom extension messages, and other branches.

### Rollover

Rollover removes earlier messages from model context while keeping them in session
history. System instructions, tools, and notes survive. Turning the journal off
does not undo a committed rollover.

Save current notes before requesting rollover, then end the response. Other tools
are blocked while the request is pending. Pi commits it at a safe compaction or
pre-settlement boundary and can continue with the notes. Errors and interruptions
do not trigger that continuation. If another extension changes model context,
notes must be updated before rollover can proceed.

The working budget is 90% of the context window. A reminder arrives with up to
6,144 tokens left (10% on smaller models). Beyond that budget, only note writes,
deletes, and rollover are allowed. A checkpoint reserve adds at most 16,384 tokens
without exceeding 98% of the window; exhausting it aborts further work.

Completed responses are not interrupted. If the next idle input arrives after
the budget is spent, rollover precedes submission. Journal mode defers native
threshold summarization; ordinary `/compact` and overflow recovery keep Pi's
behavior when no journal rollover is pending.

## Dependencies and limitations

- Uses public Pi tools, context, session, and usage APIs, host TypeBox, and shared
  redaction helpers. Cross-platform; no third-party packages or external storage.
- Rollover requires at least one note and a fresh checkpoint covering current
  work. New input, tool work, or a completed response without a rollover request
  makes earlier notes stale. Checkpoints cannot be reused after compaction.
- Continuation depends on complete notes. The extension cannot recover omitted
  facts automatically, and estimates cannot predict unusually large responses.
- Manual reset and input-triggered rollover use Pi's compaction preparation,
  which may refresh provider credentials or report “nothing to compact” for a
  small session. Failures retain notes. Pre-settlement rollover needs neither
  summary preparation nor a separate authentication check; neither path calls a
  model to summarize.
- Notes use Pi's session persistence, which may wait for the first assistant
  message before writing to disk.
- Known questionnaire secrets are redacted by literal matching; avoid storing
  secrets. This does not detect all credentials.
- Context usage is unknown after compaction until another provider response.
  The footer badge `ctx:auto` indicates enabled journal mode.
