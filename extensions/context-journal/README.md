# context-journal

Branch-local working notes and retrieval of older session messages. Disabled by
default; use [`memory`](../memory/) for notes shared across sessions.

## Usage

```text
/context-journal on       Enable tools and notes in model context
/context-journal off      Disable tools and note anchors, retaining notes
/context-journal status   Show state and storage limits
/context-journal reset    Roll over while idle, after saving notes
```

Settings and note versions follow the session branch through resume and tree
navigation.

| Tool | Purpose |
|---|---|
| `context_notes` | List, read, write (replace a key), or delete notes |
| `context_history` | Search messages and tool calls on the current branch, including before compaction |
| `context_budget` | Read Pi's context estimate and checkpoint budget |
| `context_rollover` | Request fresh context from saved notes, without a generated summary |

Calls render as compact cards with a one-line summary; expand them to read note
text, history excerpts, or errors.

Record the objective, constraints, decisions, evidence, and unfinished work.
The model sees notes through its own `context_notes` calls, the rollover
summary, and a hidden anchor saved once after resume, tree navigation, native
compaction, or enabling, unless an earlier anchor or rollover summary already
shows the current notes. Notes are never appended to each request, so the
prompt cache keeps covering history. Keys allow 1–64 letters, digits, dots,
underscores, or hyphens. Limits: 32 keys, 4,000 characters per value, 16,000 total.
Deleting a note leaves older versions in the session file and backups.

History search is literal and case-insensitive, newest first. Omit `query` for
recent text; pass `nextBefore` as `before` for older results. It returns up to
20 matches, with 2,000 characters per excerpt and 12,000 combined, plus headers.
It covers message text and tool calls (`[tool call: name] {arguments}`), labels
tool results `tool:<name>`, and searches thinking only with `includeReasoning`.
It excludes images, custom extension messages, and other branches. Codemode
scripts get `matches` (`id`, `role`, `excerpt`) and `nextBefore` as structured data.

### Rollover

Rollover removes earlier messages from model context while keeping them in session
history. System instructions and tools survive; the compaction summary restates
the notes. Turning the journal off does not undo a committed rollover. A dim
divider in the transcript marks each rollover, for example `Context reset —
automatic at 91.2% — no summary`, and flags stale notes.

Save current notes before requesting rollover, then end the response. Other tools
are blocked while the request is pending. Pi commits it at a safe compaction or
pre-settlement boundary and can continue with the notes. Errors and interruptions
do not trigger that continuation. If another extension changes model context,
notes must be updated before rollover can proceed.

The working budget is 90% of the context window. A hidden reminder is saved
once, after the turn that leaves at most 6,144 tokens (10% on smaller models).
Beyond that budget, a one-time notice follows and only note writes, deletes, and
rollover are allowed. `codemode` calls still start, since each call a script
makes meets the same rule; with `codemode.mode: "only"` scripts are the only
way to save notes. A checkpoint reserve adds at most 16,384 tokens
without exceeding 98% of the window. If a tool chain spends it, Pi rolls over
to the saved notes after that turn and continues; without notes it stops the
run once, and the next prompt can still save notes.

Completed responses are not interrupted. If the next idle input arrives after
the budget is spent, rollover to the saved notes precedes submission. Native
threshold compaction after a finished response also becomes a rollover when
notes exist; during a tool chain it is deferred. Ordinary `/compact` and
overflow recovery keep Pi's behavior when no journal rollover is pending.

## Dependencies and limitations

- Uses public Pi tools, context, session, and usage APIs, host TypeBox, and shared
  redaction helpers. Cross-platform; no third-party packages or external storage.
- Rollover requires at least one note. `context_rollover`, and `reset` before
  the reserve is spent, also require a fresh checkpoint covering current work.
  New input, tool work, or a completed response without a rollover request
  makes earlier notes stale. Checkpoints cannot be reused after compaction.
  Automatic recovery accepts stale notes and tells the model to retrieve
  recent history.
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
- Disabling hides earlier note anchors from requests, a one-time cache reset;
  rollover summaries keep their notes.
- Context usage is unknown after compaction until another provider response.
  The footer badge `ctx:auto` indicates enabled journal mode.
