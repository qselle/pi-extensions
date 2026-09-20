# handoff

Carries a reviewed task checkpoint into a fresh Pi session while preserving the
original session and validated goal/plan/journal state.

## Usage

```text
/handoff        Review the latest checkpoint (searchable TUI, text elsewhere)
/handoff edit   Edit the summary in Pi's native editor
/handoff new    Start fresh context from the reviewed checkpoint
```

Ask the agent to call `prepare_handoff` with the full user objective, constraints,
decisions, changed files, exact test evidence, unresolved questions, unfinished
work, and the next concrete action. It accepts a `summary` (up to 20,000 characters)
and optional `next_prompt` (up to 2,000). Preparing a checkpoint does not replace
the session or mark any work complete.

`/handoff new` seeds the new session with the summary and the latest valid goal,
plan and context-journal records from the current branch. Goal objective, status, usage budget,
consumption and progress survive. An active goal retains its existing automatic
continuation behavior; other tasks wait for a user message. The optional next
prompt is placed in the editor without submission.

The original session is retained and linked as the parent. Workspace files remain
unchanged. Reopen the parent through Pi's session navigation to inspect original
evidence. Running managed jobs stop through their normal shutdown handlers.

A newer user request makes a prepared checkpoint stale. Prepare a new checkpoint
or review/edit it before starting fresh context. Session changes while editing
prevent saving the old draft. Active runs and queued messages block handoff.

## Dependencies and limitations

- Uses Pi's public session setup/replacement, custom entry, tool and editor APIs.
  Uses the existing transcript viewer and goal/plan validation helpers.
- Checkpoints live in the source session. Pi normally persists sessions after the
  first assistant message. A fresh destination is therefore not saved to disk
  until its first real assistant response; the source checkpoint remains the
  recovery copy. No fabricated assistant message forces a disk write.
- Summaries are fallible: the destination is told to verify files and evidence.
  Fresh context cannot reconstruct omitted facts or attachments automatically.
- Only validated goal/plan/journal state is transferred. Tool logs, images, background
  process handles, timers and other extension state stay in the source session.
- Known questionnaire secret values are redacted when preparing/editing a
  checkpoint. This is literal redaction, not comprehensive credential detection;
  review summaries before saving sensitive material.
- Handoff is user-initiated. No automatic context threshold switches sessions,
  background summarization calls, network services, or external memory stores.
- No additional runtime packages; cross-platform.
