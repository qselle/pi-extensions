# Pi 0.87 compatibility audit

Reviewed on 2026-09-21 against the published **0.87.0** packages, upgrading
from 0.86.1 after pulling `main` through `38bba5a`. Development dependencies
are pinned to 0.87.0; peer dependencies require `>=0.87.0 <0.88.0`.
The installed local Pi CLI was also upgraded and reports `0.87.0`.

Sources: [0.87.0 release](https://github.com/earendil-works/pi/releases/tag/v0.87.0),
[tagged changelog](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/CHANGELOG.md),
[extension API](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/extensions.md),
[session format](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/session-format.md),
[model settings](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/models.md).
The release diff and installed public declarations were reviewed against 0.86.1,
then checked with the repository tests, native runtime fixtures and a fresh install.

## Release changes and decisions

- **Canonical session context:** Pi now builds provider requests from the session
  manager. No production extension overwrites `session.agent.state.messages`.
  Child sessions already use public session-manager construction and canonical
  parent context; a regression test verifies that forked context honors native
  omissions and replacements while leaving parent history intact.
- **Append-only context edits:** `/context` now estimates the canonical projection,
  retaining source-entry attribution while respecting edited or omitted messages.
  Historical provider usage remains a raw measurement. Native tests cover user,
  assistant and custom-message edits, attribution and branch restoration.
  History search, transcript display, journal history and usage export intentionally
  continue to read raw history: context edits do not erase past work or spending.
- **Actionable extension boundaries:** context-journal now returns a retain-none
  compaction draft and `continue: true` from `agent_before_settle`, replacing its
  old post-settlement compaction handler. The host commits the boundary and resumes
  once with saved notes and native prompt/tool state. Error and aborted outcomes
  never request this continuation. Existing checkpoint freshness checks and tool
  gates remain; state-only metadata proposals are preserved, while competing model
  context proposals defer rollover until notes can cover them.
- **Retain-none compaction:** the new boundary uses `firstKeptEntryId: null`, so no
  sentinel entry is needed there. Manual and idle-input rollover still use the
  public compaction hook, whose result requires a string boundary; that path keeps
  its marker. Native tests verify continuation, hard exits, raw history, disk
  reload and operation with automatic compaction disabled.
- **Settlement notifications:** existing goal, loop, monitor and schedule behavior
  retains its timing, delivery and accounting semantics. The new boundary is not
  a replacement for their timers or queues. A native test verifies that a queued
  follow-up starts only after every `agent_settled` handler finishes and does not
  cause a reentrant `agent_start` inside the notification dispatch.
- **Protected system context:** existing `context` handlers only transform
  conversational content and remain on that event. Pi now restores prompt/tool
  state afterward. None needs to take responsibility for the entire transcript
  with `context_with_system`. The native rollover fixture checks instructions and
  built-in tools in every provider request, including the first after compaction.
- **Image limits:** host resizing reduces image dimensions; image-history defers
  earlier images and provides selective retrieval. Both remain useful. Tests now
  verify that an omitted image does not return when deferral is toggled off and
  that branch navigation restores the appropriate context. Resizing does not
  provide a transparent storage-sidecar API.
- **Other breaking changes:** no production code uses the removed
  `shouldStopAfterTurn` option or directly dispatches `turn_end` through
  `ExtensionRunner.emit()`. Existing entry handling and boundary listeners compile
  with the expanded public types. Strict-schema fallback, cache-warming deadlines,
  file detection and terminal fixes are supplied by the upgraded host.
- **Supported host and documentation:** doctor now recognizes 0.87.x. Installation
  instructions, the UI fixture and the host-API gap document match the new minimum.
  No custom code-fence renderer or grammar registration API was added.

## Every extension

All **38 extensions are retained**: none is fully superseded by Pi 0.87.0.
The obsolete journal settlement handler was removed instead of deleting a useful
extension. “Compatible” below means its relevant contracts were reviewed and its
existing tests pass on 0.87.0, with no release-specific production change needed.

| Extension | Result and evidence |
|---|---|
| background-jobs | Compatible; managed execution, PTY cleanup, strict-schema metadata and renderer composition remain useful and tested. |
| cat-buddy | Compatible; editor decoration, animation and narrow layouts continue to use public UI APIs. |
| code-blocks | Compatible; Markdown transforms and language aliases remain useful; no native custom fence/grammar API replaces them. |
| codex-prompt | Compatible; custom editor composition preserves native spinner methods and prompt behavior. |
| context | Updated to attribute canonical projected messages after context edits; native omission, replacement, usage and branch tests added. |
| context-journal | Updated to the actionable pre-settlement boundary and retain-none compaction; native continuation, error/abort, persistence and settled-queue tests added. Manual reset remains supported. |
| doctor | Updated host support to 0.87.x; diagnostics remain read-only. |
| fast-mode | Compatible; request transformation and normalized provider-adapter tests pass. |
| file-changes | Compatible; mutation tracking and branch restoration describe actual file activity, independent of later context edits. |
| footer | Compatible; raw session usage and standalone cache-warming usage remain historical totals; branch-sensitive caching is retained. |
| goal | Compatible; context injection, response budgets, persistence and deferred controls pass. Native boundary continuation does not replace goal policy. |
| handoff | Compatible; public session creation and selective checkpoint transfer remain valid with canonical context. |
| history-search | Compatible; user prompt history remains raw and searchable after model-context edits. |
| hyperlinks | Compatible; public Markdown transforms and terminal capability checks remain useful. |
| image-history | Compatible implementation; native regression coverage added for context omissions, mode toggles and branch restoration. Host image resizing is complementary. |
| loop | Compatible; scheduling, settlement accounting and deferred controls retain their semantics. |
| memory | Compatible; explicit durable storage and recall tools are not replaced by session-local context edits. |
| monitor | Compatible; command polling, cancellation and wakeups still require its scheduler. |
| notify | Compatible; notification lifecycle remains distinct from actionable boundaries and standalone usage entries. |
| overlay-stack | Compatible; modal coordination, layout and cleanup pass, including native terminal checks. |
| plan | Compatible; conversational context injection, state persistence and branch navigation remain on public APIs. |
| prevent-sleep | Compatible; lifecycle/process tests pass; documented macOS-only behavior remains. The optional OS assertion test was skipped. |
| questions | Compatible; tool schemas, answer handling, secrets, UI and Telegram race tests pass. |
| rewind | Compatible; public session navigation/fork operations preserve canonical context and raw history. |
| schedule | Compatible; persisted schedules, cron/timezone handling and queued delivery remain necessary. |
| session-search | Compatible; native discovery, cancellation and public clipboard delegation pass. |
| session-title | Compatible; pulled default Herdr-tab synchronization is preserved, with registry model calls and title lifecycle tests passing. |
| side-chat | Compatible; independent registry streaming and context handling pass without assigning host message caches. |
| subagents | Compatible implementation; new regression verifies forks use edited parent context without altering parent history. RPC and continuity tests pass. |
| telegram | Compatible; service, inbox, topic routing and cross-process fixture tests pass without live messages. |
| tool-render | Compatible; syntax highlighting, execution delegation, schemas and both managed-Bash load orders pass. |
| transcript | Compatible; raw user-facing history intentionally stays visible after model-context edits; rendering/search tests pass. |
| turn-separator | Compatible; response timing and usage rendering remain separate from structural context boundaries. |
| turn-stats | Compatible; multi-response accounting and settlement persistence pass with the expanded event types. |
| usage-export | Compatible; raw usage export retains actual spending even when messages are omitted from future requests. |
| verify | Compatible; file-change triggers, command trust and execution tests pass. |
| web-search | Compatible; search/reader provider clients, tool schemas and native rendering are unaffected by the release. |
| working-status | Compatible; native indicator customization and decorated-editor rendering pass in active and settled states. |

## Validation

- `bun run check`: TypeScript passes; **1,159 tests pass, 1 optional native macOS
  sleep-assertion test skipped, 0 failures**, across 169 files.
- `bun run check:install`: archive validation and a fresh consumer installation
  with Pi 0.87.0 pass; a real native PTY executes, and all 38 extensions load and
  shut down in both orders without network calls.
- `bun run preview:ui`: native PTY checks pass at 100 and 60 columns, including
  active/settled state, overlay visibility, transcript search, doctor and loop
  views; zero extension errors and zero network attempts.
- `pi --version`: the installed global CLI reports `0.87.0`.
- `git diff --check`: passes.

Tests use local synthetic providers; no live paid model requests or external
messages are sent. This release was validated on the current macOS host; Linux
and Windows were not rerun. Restart existing Pi processes to load the upgraded
host and extension implementations.
