# context-journal

Opt-in, branch-aware working notes and retrieval of older session messages.
This is session-local context support, separate from cross-project `memory`.

## Usage

```text
/context-journal on       Enable tools and notes in future model requests
/context-journal off      Disable tools/injection, retaining saved notes
/context-journal status   Show state and storage limits
/context-journal reset    Roll over now while idle, after saving notes
```

New sessions start disabled. Settings and note versions are append-only custom
session entries; resume and tree navigation restore the selected branch's state.
The reviewed `/handoff new` workflow also transfers validated journal state.

When enabled, four tools become active:

- `context_notes`: `list`, `read`, `write` (replace a key), and `delete`.
  Use notes for the full objective, constraints, decisions, evidence and unfinished
  work. Keys contain 1–64 letters/digits/dots/underscores/hyphens. Limits: 32 keys,
  4,000 characters per value and 16,000 characters total.
- `context_history`: literal case-insensitive search over text in the complete
  current branch, including messages before native compaction. Results are newest
  first, with entry IDs and excerpts near the match. Pass `nextBefore` as `before`
  to page older results. Omit `query` to inspect recent text.
- `context_budget`: Pi's current context estimate and checkpoint budget. Unknown
  usage is reported as unknown, never as an empty window.
- `context_rollover`: request a no-summary rollover after saving current notes.
  The agent must end its response after requesting. The boundary commits at Pi's
  next safe automatic compaction point or through Pi's `agent_before_settle`
  boundary; other tools cannot run while it is pending. The pre-settlement path
  retains no earlier conversation, preserves the prompt/tools, and requests one
  continuation with saved notes. Errors and interruptions never trigger it.

Notes are supplied once in each model request as fallible working records.
Changing a note takes effect on the next request. Disabling removes that injected
context immediately for future requests. Deleting a note does not erase its older
versions from the session file or backups.

The working budget is 90% of the model context window. One hidden reminder is
sent with up to 6,144 tokens remaining (10% of the window on smaller models).
Beyond the working budget, only note writes/deletes and rollover are permitted.
The checkpoint reserve is at most 16,384 tokens and never extends beyond 98% of
the window. Exhausting that reserve aborts further work. Estimates cannot predict
a single unusually large tool result or provider response.

Completed responses are not interrupted. If the budget is spent when the next
idle user input arrives, rollover happens before that input is submitted. At
least one saved note is required. Native threshold summarization is deferred
while journal mode is enabled; ordinary `/compact` and overflow recovery retain
Pi's behavior when no journal rollover is pending.

Rollover commits a real append-only Pi compaction boundary with a fixed handoff,
without an LLM-generated summary. Earlier messages leave model context while
remaining visible in session history and retrievable with `context_history`.
System instructions, tools and durable notes survive. Turning the journal off
stops future rollover but does not undo a committed boundary.
If another boundary handler proposes new model context, rollover is deferred
until updated notes cover it. State-only metadata proposals are preserved.

## Dependencies and limitations

- Rollover requires a fresh note update covering the current work. New user
  messages, ordinary tool work, or a completed response without a rollover request
  make earlier checkpoints stale. A checkpoint cannot be reused after compaction.
  Old sessions without checkpoint markers must update notes before their first
  rollover. Stale notes never authorize an automatic no-summary boundary.
- History tool output includes the continuation cursor or an explicit end marker
  in model-visible text; the cursor exists only when older matches remain.

- Pi public tools, context transformation, session and usage APIs; host TypeBox.
  Internal output sanitization and questionnaire secret-registry helpers.
- No model call to generate a summary, network service, embeddings or external
  storage. A successful pre-settlement rollover resumes normal model work once.
- History retrieves text only. It omits reasoning, image payloads and custom
  extension messages. It searches the active branch, not other branches/sessions.
- Up to 20 matches, 2,000 characters per excerpt and 12,000 combined excerpt
  characters. Entry headers add a small amount of overhead. Search reads the
  branch's in-memory messages and scans full message text before excerpting.
- Known questionnaire secret values are redacted from notes and retrieved text;
  this is literal matching, not general credential detection. Avoid storing secrets.
- Pi 0.87 prompt/tool state survives the native compaction boundary, including
  a no-summary journal rollover and disk reload.
- Uses Pi's normal session persistence. If a session has not yet produced an
  assistant message, Pi may not have flushed its file yet.
- Manual `/context-journal reset` and input-triggered rollover use Pi's compaction
  hook. Pi must be able to prepare compaction and resolve the selected model's
  credentials before it invokes the public hook. Very small sessions may report
  “nothing to compact”; provider authentication may refresh even though no
  summarization request is made. Failures retain notes and allow retry. The new
  pre-settlement path appends a native retain-none compaction draft directly and
  does not need summary preparation or a separate authentication check.
- Reliable continuation depends on complete, current notes. A nonempty journal
  is required but cannot prove that the agent recorded every relevant fact.
- Pi reports unknown context usage after compaction until a new provider response;
  the footer does not fabricate a zero. `ctx:auto` identifies enabled journal mode.
- During active work, explicit rollover commits only at a safe Pi boundary. It
  does not replace live agent state through private APIs or abort a normal
  response just to roll context.
- Cross-platform; no third-party runtime packages.
