# Extension improvement plan

Research started 2026-09-19. Implement original designs using Pi's public API;
reference projects inform capabilities, not source code or visual imitation.

The latest [setup decisions](setup-design.md) govern scope: host-native reload,
integrated Telegram session topics, shared local reply delivery, and feature-sized
commits. The older delivery log below is historical.

The [current capability audit](parity-audit.md) separates local implementation
evidence from incomplete features and unverified live behavior. The delivery log
below is historical evidence, not a requirement to reproduce an entire catalog.

The requested implementation pass is complete as of 2026-09-20 under the scope
below. The [delivery acceptance review](parity-audit.md#delivery-acceptance) maps
the user's requirements to code, runtime and visual evidence. Optional external
service checks and explicitly deferred host/Ghostty features retain their stated
limits; no claim of universal superiority is made.

## Current scope

Updated by the user on 2026-09-20: prioritize relevant improvements to existing
extensions, especially their UI and behavior on macOS and a Linux VM. Use lessons
about readability, navigation and workflow to design original implementations;
do not copy source or presentation or add features just to match a catalog.

- Focus on the editor, footer, working state, workflow cards, tool output,
  history/session navigation, goals/plans, questions and related automation.
- Web search and ax reading remain explicitly requested additions.
- Telegram topics belong inside the existing integration; preserve session and
  reply identity across concurrent sessions instead of adding a separate bridge.
- Exa is the selected default: use keyless hosted search out of the box, with an
  optional API key for direct access. Key absence is not a search blocker.
- Keep current-host compatibility and public APIs. Custom code-fence rendering,
  grammar registration and transparent image storage are deferred by user choice;
  see [the compatibility decision](host-api-gaps.md#compatibility-decision).
- Use Pi's built-in `/reload`. Cross-session reload coordination was removed;
  it adds no useful workflow for this setup.
- Ghostty pane integration remains research for later. Windows and Linux desktop
  integration are not targets for this macOS/Linux VM portability pass. Sleep
  prevention is intentionally macOS-only.

Judge an improvement by a concrete user-visible benefit, focused regression
coverage and relevant runtime evidence, not extension count or test count.

## Lessons applied to existing extensions

| Lesson | Applied improvement | Evidence |
|---|---|---|
| Keep active work visible when space shrinks | Workflow cards become compact summaries; footer retains context essentials | Native wide/narrow UI captures and viewport tests |
| Put the next useful action first | Reports open at the overview with warnings and fixes first; narrow help retains close/search/scroll | Native doctor and snapshot panel fixtures |
| Make navigation match what the reader sees | Transcript search finds phrases across visual wraps and preserves match position when resizing | Native Markdown width sweep and large-transcript fixture |
| Treat session replacement as a lifecycle boundary | Searches, reports and dialogs discard late results instead of modifying a replacement session | Deferred-result and navigation tests |
| Detect the available capability, not just the OS | Clipboard backends follow display availability; diagnostics recognize terminal-owned notifications | macOS/Linux/terminal-environment regression cases |
| Validate the installed package as well as the checkout | Isolated consumer installation checks runtime dependencies and an actual PTY | `check:install`; Linux runner supports `--clean-install` |

These are independent changes to this project's existing architecture. New
extensions need a concrete workflow reason; catalog completeness is not one.

## Delivery order

1. **UI foundation (first delivery implemented).** Preserve context visibility in narrow footers,
   communicate context pressure with semantic colors, and add phase-aware elapsed
   working status. Test tiny widths, Unicode, parallel tools, session changes,
   cancellation, and headless mode. Keep the existing theme and editor bindings.
2. **Web research (first delivery implemented).** Add search providers and an optional ax page reader with
   explicit provenance, bounded output, cancellation, timeouts, and actionable
   configuration errors. Distinguish search from page extraction. Do not install
   binaries or invoke paid services merely to render the UI.
3. **Navigation and execution.** Transcript viewer, rewind, managed background
   commands, and setup diagnostics. Reuse existing session search, overlays,
   notifications, and usage accounting.
4. **Rendering and context.** Review code-block highlighting, large transcript
   performance, image sidecars, and durable context rollover against public API
   support. Avoid private renderer patches; benchmark before adding caches.
5. **Optional integrations.** Provider fast-mode controls,
   terminal pane workflows, and usage export only with explicit configuration.
   Ghostty is a research track first, not a required runtime dependency.

## Capability checklist

| Capability | Existing foundation | Remaining work / improvement target |
|---|---|---|
| Editor accent and companion | codex-prompt, gruvbox theme, cat-buddy | Theme/fixed/thinking editor accents; companion lifecycle and collision fixes verified with native editing checks |
| Native tool blocks and file links | tool-render, hyperlinks | File links audited; expanded exploration output, grouped failure diagnostics and multiline errors verified |
| Footer and activity | footer, turn-separator | Responsive essentials, pressure colors, live phases |
| Overlay cards | overlay-stack | Fair extra-row allocation and short-card space reclamation implemented and tested |
| Goal and nested plans | goal, plan | Nested plans verified; goal audit distinguishes cancelled checks and guards stale dialogs/continuations; semantic completion still requires agent verification |
| Session naming and search | session-title, session-search, history-search, rewind, transcript | Rewind, rename, and searchable live transcript implemented; native-renderer tests pass |
| Context inspection and memory | context, memory, handoff, context-journal | Reviewed handoff plus opt-in no-summary rollover, checkpoint budget, notes and history implemented |
| File changes | file-changes | Net edit/write tracking audited; fixed diff prefixes, concurrent reads, clock rollback and home-relative paths; shell/rename tracking remains outside scope |
| Questions and side conversations | questions, side-chat | Side-chat cancellation/title isolation and questionnaire lifecycle isolation verified; live Telegram validation remains |
| Child agents | subagents, usage-export | Stale navigation invalidated on session transitions; recorded child usage included in exports |
| Notifications and Telegram | notify, telegram | Diagnostics implemented; goal-aware notification suppression verified in both native load orders; live delivery remains |
| Timers and automation | loop, monitor, schedule, prevent-sleep | Durable controls and cancellation audited; searchable inspection panels cover loops, monitors and schedules; sleep prevention is macOS-only |
| Managed background processes | background-jobs | Pipe/PTY sessions, resizing, cursor logs, redaction, cleanup and durable completion cards implemented; native macOS/Linux ARM64 behavior verified; Windows remains outside the current validation scope |
| Web search and page reading | web-search | Keyless Exa is the default and verified live in balanced/fast modes; optional keyed Exa supports deep mode; alternative providers stay explicit; live ax 0.1.25 verified |
| Setup diagnostics | doctor | Read-only report implemented with actionable fixes, bounded reads and native-renderer checks |
| Code blocks and image history | code-blocks, image-history | Named fences and retrievable older-image context references implemented; custom grammars/borders and transparent storage sidecars are deferred by the user's compatibility decision |
| Provider fast mode | fast-mode | Optional direct OpenAI Responses and ChatGPT Codex controls implemented; native request serialization verified; live eligibility remains unverified |
| Terminal panes and tab names | footer title integration; session-title Tab link | Herdr tab synchronization implemented with manual-label preservation and split-tab pause; native Pi/socket tests pass. Ghostty remains a later integration in docs/ghostty-integration.md |
| Usage collection | footer, per-turn totals, usage-export | Explicit local branch/session JSON and CSV export implemented; no automatic telemetry |

Each implemented feature needs its own README, focused behavior tests, TypeScript
validation, and a full-suite check before calling a delivery milestone complete.
Presence of an existing extension does not establish tested feature parity.

## Web findings

[ax](https://ax.yusuke.run/) is a local HTTP/HTML CLI, not a web search engine.
It supports Markdown reading, CSS extraction, page structure discovery, and
bounded output. Its [manual](https://ax.yusuke.run/llms.txt) is the integration
contract. Search needs a separate index provider. Prefer structured result URLs
and explicit provider identity; do not claim that snippets verify a whole page.

## Ghostty research (later)

The [feature documentation](https://ghostty.org/docs/features) describes graphics,
keyboard, synchronized rendering, and terminal appearance capabilities. Existing
OSC 8 hyperlinks and Pi-managed titles are the first compatibility surface to
test; avoid writing escape sequences around Pi's renderer without coordination.

[AppleScript automation](https://ghostty.org/docs/features/applescript) offers a
potential macOS pane integration. Verify installed-version support before using
it, keep command input separate from script source, and offer a platform-neutral
fallback. Linux support must be investigated separately rather than assumed.

The current documentation dates AppleScript support to **1.3.0**. It exposes
window/tab/terminal IDs, splitting, initial working directories, and tab-title
actions. Target explicit terminal IDs rather than whichever pane has focus.
macOS Automation permissions apply. Inspect the installed scripting dictionary
before implementing version-specific actions.

[Shell integration](https://ghostty.org/docs/features/shell-integration) and
[terminfo guidance](https://ghostty.org/docs/help/terminfo) matter for SSH and
working-directory tracking. Do not silently rewrite the user's terminal config.
Prototype later: open a workspace pane, synchronize its title, and surface agent
attention. Evaluate targeting, focus behavior, cleanup, and remote sessions first.

See the [installed-version feasibility study](ghostty-integration.md) for pane
ownership, process-accounting gaps, portability and acceptance checks.

## Delivery record

- Responsive footer now retains remaining context when long model identifiers
  consume the row; usage pressure has healthy/warning/critical/unknown colors.
- New `working-status` extension uses the native working row for phases and total
  elapsed time, tracks concurrent tools, and cleans up at settled/shutdown events.
- New `web-search` exposes Exa/Firecrawl search and optional ax page extraction,
  with bounded output, source previews, timeouts, and cancellation.
- Search provider tests use fixtures. No paid requests were made. ax is not
  installed in the development environment, so real ax execution remains to be
  validated on a configured installation.
- Existing child-session integration tests now isolate Pi's agent directory from
  machine-local settings. This fixes sandbox failures without reading live keys.
- Remaining parity work is tracked above; this first delivery does not establish
  complete parity or a measured claim of superiority.

### Navigation and overlay delivery

- Overlay cards share surplus height after minimums, and short cards release
  unused rows to larger cards. Tests verify constrained-height allocation.
- `/rewind [query|last]` and `/undo` fork before a chosen user prompt. The picker
  distinguishes repeated prompts and marks image attachments. Full prompt text
  returns to the editor without submission; files remain unchanged.
- A real Pi runtime integration test verifies the selected prompt is excluded
  from the fork and the original persisted session is byte-for-byte unchanged.
  Command tests cover cancellation, concurrent session changes, active runs,
  queued messages, and fresh-context-only restoration.
- `/rename` supports direct names or an interactive prompt and cancels pending
  generated titles. Manual names preserve wording and punctuation. Late explicit
  title results no longer notify a replaced session.
- Next: managed background processes and
  read-only configuration diagnostics. Existing extensions still need the
  capability-by-capability review recorded in the checklist.

### Transcript delivery

- `/transcript [all] [query]` and Ctrl+Shift+T open a native Markdown transcript
  with scrolling, search, matching-line navigation, optional thinking text, and
  automatic following that stops when the user scrolls.
- Current-branch mode includes persisted pre-compaction messages; all-branches
  mode uses every saved entry. Hidden extension context and binary image payloads
  are excluded from display. Image placeholders retain format information.
- Native-renderer tests exercise Markdown, search, live append behavior, tiny
  viewports, session shutdown, and a 130,000-line tool result. Scrolling reuses
  cached rendered text instead of loading the session again.
- The viewer accounts for Pi's message-end-before-persistence ordering, coalesces
  streaming refreshes, and releases refresh timers on close/session replacement.

### Managed process foundation

- Added `job_start`, `job_list`, `job_output`, `job_wait`, `job_write`, and
  `job_stop`, plus `/jobs` and `/ps` with a live output panel and overlay card.
- Process tests cover bounded cursor logs, Unicode, literal stdin, EOF, missing
  executables, simultaneous capacity, cancelled waits, explicit timeouts, TERM
  escalation, POSIX descendants after parent exit, and the process-exit reaper.
- Known questionnaire values are removed before metadata/output enter observers,
  including split chunks and ANSI interruptions. Values introduced through stdin
  remain covered during vault/session cleanup. Redaction is literal, not an
  encoded-secret detector or filesystem scrubber.
- Shell/session metadata and native tool rendering are exercised through Pi's
  public APIs. No new runtime packages are needed for pipe sessions.
- This is a staged foundation, not full background-terminal parity. Remaining:
  capability checks and host validation for platform-specific cleanup.

### Durable job completion UI

- Yielded start cards refresh once when a managed job settles. Later output/wait
  observations remain stable instead of changing retroactively on redraw.
- Redacted, bounded lifecycle records persist through Pi custom session entries.
  Reload restores final tails and states without restoring processes or PIDs;
  unmatched starts explicitly report unknown completion.
- Recent-job memory stays bounded while older transcript cards can resolve their
  saved completion lazily. Shutdown persists cleanup results before releasing
  the session context. Corrupt saved records are rejected.
- Focused tests cover reload, idempotent historical stop, immutable observation
  cards, one-time invalidation, retention, control stripping, and Unicode bounds.

### Interactive terminal transport

- `job_start` now accepts real PTYs under Node.js, with explicit dimensions.
  `job_resize` changes terminal dimensions; `job_write` supports terminal keys.
  Pipe EOF and terminal Ctrl+D retain distinct documented semantics.
- The same bounded, redacted logs, timeouts, lifecycle history and process-group
  cleanup serve both transports. Runtime setup uses node-pty rather than copied
  terminal wrappers; its macOS helper permission fix is scoped to installation.
- Real macOS tests verify TTY identity, prompt input, resize, Ctrl+C, Ctrl+D,
  secret redaction, nonzero exit, forced timeout and shutdown cleanup. Bun is
  explicitly rejected for PTYs after its native smoke test failed; pipes work.
- Linux/Windows host validation and full-screen terminal emulation are unverified;
  the viewer intentionally presents readable output history. Bash integration
  is delivered below.

### Managed bash integration

- The familiar `bash` tool now runs through the managed service: quick commands
  finish inline, long commands yield IDs, and explicit timeout/cancellation retain
  cleanup ownership. PTY options are available without a separate launch workflow.
- `tool-render` and the executor negotiate through Pi's public event bus. Both
  extension registrations receive the same composed definition, accounting for
  Pi's first-extension-wins resolution in either load order and after cwd changes.
- Collapsed output keeps job IDs and status visible. Yielded start cards update
  once on completion; exit codes/signals are included in observations.
- Integration checks exercise both load orders, authoritative session cwd, failed
  commands, stdin/EOF, yielded completion, narrow rendering and session rebinding.

### Local setup diagnostics

- `/doctor` opens a searchable health report; `/doctor text` returns the same
  findings without an overlay. Checks include tool activation, shell/ax helpers,
  provider-key presence, PTY prerequisites, secure Telegram configuration,
  notification/rendering settings, and platform sleep/banner helpers.
- Reports distinguish local presence from successful authentication or execution.
  No binary is run, native module loaded, service contacted, configuration changed,
  or secret value/path/parser exception included in output.
- Tests exercise missing and inactive tools, invalid and oversized settings,
  symlinks, optional services, Bun/Windows limitations, secret-free reports,
  tiny viewports, and session cleanup using the native Markdown renderer.

### Named code-block rendering

- Public Markdown transformers now separate filename/metadata captions from fence
  language names, restoring native highlighting. Filename-only fences use Pi's
  language mapper; aliases normalize without substituting incorrect grammars.
- Tests verify exact code-body preservation, literal/nested blocks, streaming
  closures, caption escaping, tiny widths and real native syntax highlighting.
- A 200-block / 14,380-character stress fixture measured roughly 37 ms per cold
  formatting pass on this host. Added an eight-entry, 512,000-character bounded
  cache for repeated source; oversized documents bypass the transform entirely.
- Pi 0.85.1's public hook transforms source but exposes no custom code-block
  renderer or syntax-grammar registration. Native borders and unsupported Zig
  highlighting remain an explicit host-API gap, not claimed as completed parity.

### Reviewed context handoff

- `prepare_handoff` stores a bounded task checkpoint; `/handoff` reviews it,
  `/handoff edit` revises it, and `/handoff new` starts fresh context through Pi's
  public runtime replacement API. No extra model request or automatic switch.
- Original sessions and files remain intact. Validated goal/plan state carries
  objective, progress and usage accounting; transient process/timer state does not.
- Runtime integration verifies actual new-session context, parent linkage,
  original-file preservation, goal budgets, and reopening persisted destination
  messages. Command checks cover active/queued work, newer user turns, cancelled
  edits/replacement, and concurrent session changes while editing.
- Pi defers a new session file until its first assistant message. The source
  checkpoint remains the durable recovery copy before that point; no synthetic
  assistant entry is inserted. Automatic threshold-triggered rollover remains
  separate from this explicit workflow and has not been claimed as complete.

### Durable session notes and history retrieval

- Reference documentation confirms that manual handoff alone is not context
  parity: opt-in notes, pre-rollover history retrieval, threshold reminders,
  checkpoint-only emergency budget and no-summary compaction boundaries are
  distinct capabilities. They are delivered in the next milestone below.
- Added `/context-journal on|off|status`, `context_notes`, `context_history`, and
  `context_budget`. State restores per branch; tool activation follows enabled
  state without changing unrelated tools. Notes are injected once per request.
- Notes and history excerpts have aggregate limits, control stripping and known
  secret redaction. Retrieval searches full message text before excerpting and
  excludes thinking, images and custom extension messages. Unknown context usage
  remains unknown. Reviewed handoffs now preserve validated journal state too.
- Tests cover bounds, malformed state, full-text matches outside initial snippets,
  pagination, Unicode, secret handling, activation and branch/context restoration.

### Automatic journal rollover

- Opt-in journal mode now provides the 90% working budget, one early reminder,
  checkpoint-only tool gating, and a reserve capped at both 16,384 tokens and 98%
  of the context window. Hard exhaustion aborts further work; unknown usage does
  not masquerade as zero.
- `context_rollover` and `/context-journal reset` use Pi's safe compaction boundary.
  Completed responses are preserved; idle input triggers rollover before new
  content is appended when needed. Pending rollover blocks unrelated tools.
- Real runtime integration proves native compaction persistence, absence of old
  messages from the next model context, journal injection, history retrieval,
  unchanged original file prefix, reopening, and zero network requests in the
  fixture. Manual/overflow fallback, disabled mode, errors, shutdown races and
  checkpoint restrictions have focused tests.
- Public Pi compaction requires model/auth preparation and a compactable session.
  Native authentication refresh remains possible; no summarization call is made
  by this policy. Context remains unknown until fresh provider usage arrives.

### Nested tactical plans

- Plans now support three levels of groups, up to ten siblings and forty total
  nodes. Only leaf steps count toward progress; group status derives from their
  descendants and cannot override unfinished work. Cancelled leaves are reported
  separately from successfully completed leaves.
- The panel supports keyboard navigation, folding and scrolling within terminal
  height. Active groups start expanded; the compact card retains the active leaf
  even when allocated only one row. Tool/context output preserves the full tree.
- Flat version-1 records remain readable, while nested plans persist as version 2.
  Tests cover branch restore, nested context injection, derived progress, depth
  and size limits, native Unicode widths and key handling. A stale clear-dialog
  race was also fixed, and state is committed only after persistence succeeds.

### Net file-change audit

- Verified first-mutation baselines and reversion removal for tracked edit/write
  calls. Fixed undercounting when actual diff content starts with header-like
  plus/minus runs, and restored summaries now follow append order rather than
  wall-clock timestamps.
- In-flight baseline reads are deduplicated; late refresh completions cannot
  overwrite newer observations. Session replacement does not redraw from an old
  run, and home-relative paths match the shell/tool convention.
- Deterministic deferred-read tests verify both concurrency cases. Shell-created
  changes and renames remain outside this tool-event-only overlay; no broader
  workspace tracking is claimed by the audit.

### Consistent editor accents

- The editor now defaults to the live theme accent, with fixed hex colors and
  native thinking-level colors available through `/codex-prompt accent`.
  Settings updates preserve unrelated fields and reject malformed files.
- Repeated installation cannot wrap its own factory recursively. Rendering
  restores the host border color even after failure, preserving later theme and
  thinking-level updates and other editor decorators.
- A real editor fixture verifies cursor movement, wide characters, multiline
  bracketed paste, deletion and the embedded working label. It exposed a native
  recursion failure at tiny widths; a minimum internal canvas with final clipping
  now handles those widths without overflowing the requested terminal width.

### Companion composition audit

- Companion installation now survives repeated session starts, including another
  decorator wrapping its factory. Each editor owns its sprite; replacement and
  shutdown dispose its timer, and late renders cannot borrow a newer sprite.
- Docking checks the border segment before replacing it. Status text and other
  decorations retain their columns, with the cat using a separate row when needed.
- Focused lifecycle tests cover duplicate installation, old editor renders and
  timer disposal. A native editor fixture verifies both prompt/companion decorator
  orders, cursor movement, Unicode, multiline paste, bounded widths and full
  working-status preservation.

### Explicit local usage export

- Added `/usage-export branch|session json|csv [new file]`. Without a destination
  it previews totals; exporting is an explicit command and creates a new local
  file with restrictive permissions, refusing existing files and symlinks.
- Records use an allowlist of usage and attribution fields, with no conversation
  or tool content. Cache categories remain separate, missing values remain null,
  and totals report missing counts rather than presenting unknown values as zero.
- Export includes recorded nested-tool and summary usage, deduplicates entry IDs,
  and neutralizes spreadsheet formula prefixes in CSV. Focused tests cover
  branch/session selection, partial usage, metadata escaping, privacy boundaries,
  file permissions, collision refusal and filesystem errors.
- This delivers explicit export, not an automatic global collector. No telemetry,
  network writes, child-session scanning or inferred invoice totals are added.

### Goal completion and lifecycle audit

- Cancelled checks no longer count as successful completion. Progress exposes
  complete, non-cancelled total, and cancelled counts separately in tool output,
  context, cards and panels. The prompt explicitly ties cancellation to a user
  scope change and preserves the full-objective verification requirement.
- Clear/edit/replace/panel actions capture the goal and session generation before
  waiting for user input. Stale results cannot mutate a replacement goal or
  restored branch, and command cleanup cannot restart a shutdown session.
- Deferred-dialog tests cover all four actions across branch restoration and a
  pending confirmation across shutdown. Existing tests verify unfinished-check
  rejection, terminal-state scheduling, blocker runs and completion notification.
- Checklist state is not proof of external success; no automatic verifier of
  arbitrary objectives is claimed. Completion still requires an evidence audit.

### Side-conversation lifecycle audit

- Abort now immediately releases the chat, clears the pending question and
  invalidates its request identity. Providers that ignore cancellation cannot
  commit late answers or interfere with a newer question.
- Side-chat title requests carry abort signals and verify session generation,
  chat identity and unchanged title before applying results. Restoring a branch
  resets titling eligibility and aborts outstanding title work.
- Workspace callbacks are tied to their session generation, navigation closes
  old workspaces, and stale cleanup cannot clear a newer session's UI state.
  Promotion is marked delivered only after message dispatch succeeds.
- A native-import fixture with deferred providers verifies title cancellation,
  restored-chat isolation, manual-title preservation and cancellation during
  credential resolution. Store tests cover a provider that ignores abort.

### Questionnaire lifecycle audit

- Pending input races now have extension-owned cancellation in addition to the
  tool signal. Session starts, branch switches and shutdown abort all channels,
  clear secret handles and invalidate the old generation.
- Replies that arrive after navigation cannot issue secret handles or return
  earlier answers into the new session. Old cleanup and delayed warnings cannot
  overwrite a newer questionnaire's UI state. Already-aborted calls open no UI.
- Tests cover all three lifecycle events, delayed replies, overlapping old/new
  cleanup and pre-aborted execution, alongside the existing first-reply-wins,
  Telegram failure, secret masking and handle-substitution coverage.

### File-link correctness audit

- File URLs now encode literal fragment/query characters correctly, preserve
  POSIX backslashes and format Windows drive/UNC paths. Windows resolution works
  independently of the host platform, and home-relative paths expand properly.
- Raw target URLs with controls cannot break out of OSC 8 sequences; invalid
  targets fall back to display text. Visible labels and their styling are retained.
- Repeated session starts restore configuration ownership before applying a new
  mode, fixing both repeated-start shutdown restoration and a later session with
  no configuration. Explicit command choices retain user ownership.
- Regression tests cover reserved characters, drive/UNC paths, raw control
  rejection and configuration transitions. Live terminal click-through validation
  remains distinct from these URI/detection tests.

### Dense tool-output audit

- Expanded read/grep/find/ls calls now render their own results, including group
  followers that previously remained invisible. Output is capped at 200 trailing
  lines with an explicit omission count; width clipping remains documented.
- Collapsed exploration groups retain a bounded failure diagnostic, including
  when a failed read coalesces with a successful read of the same path. Error
  results for bash/edit/write now retain multiline diagnostics instead of only
  the first line, with eight collapsed or 200 expanded lines.
- Native renderer assertions cover grouped failure visibility, follower expansion
  and dense-output limits. Shared path resolution now also reaches tool-card
  links, keeping Windows and home-relative targets consistent with hyperlinks.

### Provider fast-mode first delivery

- Verified the installed public request-payload hook and Responses adapter against
  the [official Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode).
  Added `/fast on|off|status`, using the documented priority alias understood by
  the current Pi adapter. The default is off, with no persistent configuration.
- Scope is deliberately visible: direct OpenAI Responses requests only, bound to
  the current model and endpoint. Model/session/branch changes reset the override;
  independent side requests and child processes do not inherit it.
- UI reports requested rather than confirmed. Actual tier, premium pricing,
  account eligibility and adapter-dependent usage estimates are documented;
  off restores provider/project defaults rather than forcing standard service.
- Tests cover explicit opt-in, immutable payload replacement, request/model
  mismatch, invalid payloads, endpoint/protocol gates and lifecycle resets.
  No paid provider requests were made. Other transports/providers still require
  their own verified contracts and remain part of the outstanding parity work.

### Coordinated reload first delivery

- Added explicit join/leave and workspace-scoped list/send commands, plus explicit
  `all` scope. Only registered receivers participate; a joined sender reloads
  itself after dispatch. Registrations end with the current runtime/session.
- Private registry records authenticate bounded loopback requests. No remote host
  from a registry file is accepted. Idle/queued-message checks happen both before
  dispatch and in the one-use queued command that calls public `ctx.reload()`.
- Real TCP tests verify authentication, busy replies, discovery and unregistering;
  a native-import command fixture verifies scope, opt-in, duplicate-command
  refusal and the second busy check. The sandbox required approved loopback
  access for these tests; there were no external requests.
- Queued is reported as queued, not completed. Full native multi-terminal reload,
  Linux/Windows validation and crash-registry housekeeping remain explicit limits.

### Native coordinated-reload verification

- A two-session native Pi fixture exposed that `sendUserMessage` defaults to
  literal model input unless `expandPromptTemplates` is explicitly enabled.
  Internal reload dispatch now enables command expansion and defers until after
  the loopback reply, preventing shutdown from destroying the reply socket.
- The fixture verifies actual extension-runner replacement, preserved session
  identity, removed receiver registration, zero conversation messages, zero model
  turns and zero external fetches. Deferred dispatch is cancelled on shutdown or
  session replacement. The earlier command mock alone did not prove this route.
- Separate interactive terminal processes and other operating systems remain
  manual validation targets; the native runtime path itself is now exercised.

### Child navigation and usage audit

- Transcript selection now carries a UI revision. New navigation, session starts,
  tree changes and shutdown invalidate pending selections and close the viewer;
  old finalizers cannot clear a newer viewer's refresh callback.
- Usage export now understands the package's durable child-agent usage records,
  which were previously excluded as generic custom entries. Provider/model,
  cache categories and costs are retained; task text, names and child IDs are not.
- Native-import navigation tests cover delayed selections across lifecycle events
  and closing an open viewer. Export tests verify mixed parent/child totals,
  record deduplication, unsupported record versions and metadata exclusions.

### Retrievable image-history context

- Added opt-in `/image-history on|off|status` and `history_image`. Earlier user
  and tool-result images become references only when recoverable from the current
  branch. All images in the current user turn remain available; text is unchanged.
- Mode persists per branch and controls retrieval-tool activation. Original session
  entries are never rewritten; unknown-source images remain intact. Disabling
  restores the host's ordinary context behavior, subject to native compaction.
- Native Pi integration verifies actual context transformation, tool activation,
  original-image retrieval and byte-for-byte unchanged history during retrieval.
  Unit coverage includes branch references, malformed state and missing sources.
- Transparent image sidecars remain a storage-hook gap. This delivery reduces
  repeated model image input, not session-file size or host memory consumption;
  it does not claim a vision-provider round trip or measured token savings.

### Goal-aware notification integration

- The notification extension subscribed to `goal:changed`, but the goal extension
  never emitted it. Goal persistence and restoration now publish a versioned,
  status-only event; objective text is not exposed through this integration.
- Notifications independently restore active-goal state from branch entries,
  making suppression reliable across load order, resume and tree navigation.
  Routine completion pings stay quiet during active goals; question attention
  remains available and paused goals permit normal completion notifications.
- Native Pi tests exercise both extension load orders, goal creation/pause and
  restored active state. Delivery is captured in the fixture rather than posting
  real desktop banners. Sleep inhibition and live OS delivery remain separate
  validation items.

### Sleep-inhibition lifecycle audit

- Status now separates starting/running helpers from unavailable helpers. Spawn
  errors and unexpected exits retain an actionable diagnostic instead of appearing
  as idle while the agent is working. Running is not presented as independent OS
  assertion verification.
- Session starts release old helpers and reset activity; shutdown prevents late
  agent-start events from reacquiring one. Child identity checks prevent an old
  exit/error from clearing a newer helper. No retry timer is introduced.
- Injected-process tests cover startup failure, unexpected exit, session reset,
  stale child events and post-shutdown activity. OS assertion verification was
  checked later on macOS; Linux inhibition was subsequently removed from scope.

### Live ax validation and structured extraction

- The current environment now has ax 0.1.25. Live GET checks through the actual
  reader succeeded for Markdown, outline and extraction on the public ax site.
- Validation exposed a contract gap: JSON envelopes are incompatible with md,
  outline and text flags. Extraction now uses supported `--row text=` plus
  `--json-envelope`, validates metadata and reports an exact continuation offset.
- Live extraction returned `more` with offsets 3 then 6 and distinct content;
  a heading selection returned complete. Markdown nonzero offsets are rejected,
  and modes without structured metadata explicitly report unverified completeness.
- Process fixtures and pagination tests were updated. No paid search API calls,
  credentials, global binary installation or disk cache were involved. Earlier
  notes saying ax was unavailable describe the environment before this check.

### Diagnostics for the expanded feature set

- Doctor now validates editor accents and hyperlink modes using bounded local
  configuration reads without including configuration contents in its report.
- Optional image-history and context-journal tools report inactive as off, not
  broken. Active-tool findings direct users to the session policy status command.
- Fast-mode diagnostics check the current transport gate while explicitly leaving
  account eligibility and actual tier unverified. Reload diagnostics describe the
  explicit join requirement without claiming socket or peer connectivity checks.
- Focused tests cover valid and malformed configuration, optional tool states,
  supported endpoints and proxies, and the limits of metadata-only diagnostics.

### Schedule command lifecycle audit

- Reminder, cron and management commands now guard asynchronous save continuations
  across session starts, tree changes and shutdown. Old continuations cannot
  notify through stale contexts, rearm timers or roll back a new session's state.
- Queued writes capture their project destination. Stop-tool continuations report
  session changes instead of returning a misleading success with unrelated state.
- Delayed-save tests cover successful and failed writes for creation, pause,
  stop-all and model stop requests across all three lifecycle events, checking
  stale UI silence and the destination session's independent queue.

### Schedule delivery rollback

- Pause and stop commands release delivery tracking only after their changes are
  saved. Previously, a failed save restored the task but lost the queued/running
  wakeup, preventing completion accounting and allowing redelivery.
- Management commands are serialized; error and settlement handlers await their
  outcome before accounting for the current delivery. Successful controls also
  release their transient prompt references.
- Tests cover failed pause, stop and stop-all saves for both queued and running
  reminders, plus settlement arriving during a delayed failed control write.

### Searchable schedule panel

- Added `/schedule view`: a native scrollable/searchable snapshot with complete
  prompts, task IDs, recurrence timezone, UTC next-run timestamps, delivery state
  and pause/stop reasons. Compact status remains available independently.
- The panel labels its snapshot semantics, supports a full-text headless fallback,
  participates in modal overlay coordination and closes on session transitions.
- Native renderer coverage checks tiny widths, full-prompt search, empty queues,
  fallback output and cleanup on start, tree navigation and shutdown.

### Codex fast-mode transport

- Extended the explicit model-scoped fast toggle to Pi's ChatGPT Codex transport.
  Endpoint checks accept only canonical HTTPS backend paths with matching provider
  and API names, without credentials, query strings or fragments.
- The UI distinguishes increased ChatGPT credit consumption from premium API
  pricing. Defaults, lifecycle resets and requested-not-confirmed status remain.
- A native Pi adapter fixture uses a dummy local token and injected HTTP transport
  to verify serialized `priority` when enabled and no override when disabled.
  No live authentication, credit consumption or paid provider request is involved.
- Current official sources: [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed)
  and [API fast mode](https://developers.openai.com/api/docs/guides/fast-mode).
  Account eligibility and actual delivered tier still require live validation.

### Search result quality and filter enforcement

- Search now enforces requested hostnames and subdomains locally on both provider
  responses. Lookalike suffixes and domain names embedded in paths do not match.
- Structured diagnostics count invalid URLs, duplicate pages, out-of-domain rows
  and rows beyond the limit. Empty provider responses are distinguished from
  responses whose rows were all discarded, without exposing rejected URLs.
- Compact native previews flag excluded rows; expanded output explains why.
  Provider fixtures cover both response formats and native rendering tests cover
  the new indicator at narrow widths. No additional billable calls or fallback
  requests are introduced.

### Page-reader progress UI

- Compact page cards now distinguish more selection content (with exact next
  offset), complete selection, past-end and unverified excerpt completeness.
  Hard character truncation overrides completion claims in the preview.
- Structured pagination is retained in tool details. Extraction rejects
  non-advancing offsets, and request offsets must be safe integers.
- Native renderer checks cover all progress states at narrow widths; process
  fixtures verify that a repeated continuation offset fails actionably.

### Installed Ghostty feasibility

- Read the installed Ghostty 1.3.1 bundle metadata and scripting dictionary.
  Pane creation, IDs, working directories and actions are present; output capture
  and process exit status are not exposed by that dictionary.
- Added a concrete later workflow and acceptance matrix separating project shells
  from managed process supervision. No Apple Events, terminal input, app launch,
  permission prompt or configuration changes were performed.

### Whole-package composition audit

- Loading all 38 extensions through Pi's real resource loader exposed a duplicate
  `bash` registration missed by isolated event-bus tests. The renderer had claimed
  the managed definition under its own extension as well.
- Managed jobs now retains sole ownership; renderer negotiation supplies styles
  without a duplicate registration. Standalone rendering waits until session start
  to register bash after all executor owners have loaded.
- New isolated native-loader tests cover all extensions in forward and reverse
  order, check zero loader/lifecycle errors, expected commands/tools, one bash
  owner, and no network requests at startup or shutdown.
- Packaging dry-run found 356 files (about 1.81 MB), including 168 test/fixture
  files and no machine-local configuration or dependencies. Distribution filtering
  remains a follow-up; no archive was published or package installation changed.

### Distribution contents verified

- Added an explicit package file allowlist excluding tests, native fixtures and
  benchmarks while retaining runtime sources, extension READMEs, themes, docs
  and the PTY postinstall helper. The package remains private.
- Built and extracted a temporary archive: 184 files, 1,071,819 unpacked bytes
  versus the prior approximately 1.81 MB preview. Verified every extension entry
  point/README and loaded all 38 extensions from the extracted package in both
  orders without network. Existing local dependencies were reused; a clean
  dependency installation or publication was not performed.
- Whole-package fixture files are now included in TypeScript checking as well
  as tests. The runtime fixture accepts an explicit package root for artifact QA.

### Turn timing accuracy

- Separator work blocks now reset at agent boundaries and session shutdown,
  preventing final-response usage and interrupted tool timing from leaking into
  the next user turn. Existing per-round-trip separators remain intact.
- Latest-response latency and throughput are cleared before each new measurement;
  missing stream timing no longer reuses a prior response's metrics.
- Deterministic clock and lifecycle tests verify both regressions. Documentation
  distinguishes work-block totals from full-turn summaries and recorded cost
  estimates from authoritative provider billing.

### Full-run usage summaries

- Added turn-stats with durable custom entries at agent settlement and a
  `/turn-stats` command for current-run or latest current-branch inspection.
- Summaries separate whole-run elapsed time and response/tool counts from the
  separator's individual response speed. Each token/cost category tracks missing
  measurements; partial totals are explicit and missing values never become zero.
- Interrupted/error responses and failed tools remain visible. Session changes
  discard unfinished accumulators without fabricating completed summaries.
- Focused tests cover multiple rounds, repeated message objects, settlement
  idempotence, invalid measurements, boundary cleanup and branch restoration.
  Child and independent side-call usage remain outside main-run totals.

### Native full-run summary validation

- Exercised an actual Pi agent loop using an injected synthetic provider and
  a local fixture tool: two responses and one tool round persist exactly one
  summary with the expected usage totals.
- Verified the disk record through a reopened SessionManager, actual extension
  reload and `/turn-stats` dispatch without an additional model call. Summaries
  remain absent from model context and fit widths down to one column.
- This verifies lifecycle and persistence semantics, not paid-provider billing.

### Platform CI and repeatable artifact verification

- CI now defines independent Linux and macOS jobs with Node 26.8.2 and Bun 1.3.14,
  explicit native node-pty preparation, full checks and packed-artifact checks.
- Added `bun run check:package`: builds/extracts a temporary archive, rejects
  development fixtures/local state, checks extension entry points and docs, and
  runs both native loader orders against packaged files using local dependencies.
- Locally verified the artifact check for all 39 extensions and parsed the workflow
  YAML. No remote job was launched; configured matrix coverage is not evidence
  that Linux/macOS hosted CI has passed. Windows remains a separate open item.

### Date-scoped web research

- Added a validated calendar date window to web_search for both providers.
  Exa receives UTC publication start/end timestamps; Firecrawl receives its
  documented custom calendar-range filter. Invalid dates fail before requests.
- Requested bounds remain in structured results, expanded provenance and compact
  previews. Provider matching is not represented as independent date verification;
  undated results retain unknown publication dates.
- Tests cover leap days, impossible/reversed dates, provider mappings, provenance
  without publication metadata and narrow native previews. No paid calls made.

### Session-search cancellation and navigation

- Search commands now invalidate previous operations on new searches, session
  starts, tree navigation and shutdown. Stale input/picker selections, progress,
  errors and clipboard fallbacks cannot write into replacement session UI.
- Abort signals reach file streams and concurrent scan workers. Cancellation is
  propagated rather than counted as unreadable files or returned partial results.
  Initial Pi session enumeration cannot be cancelled; its result is discarded.
- Tests cover delayed listing/scanning/pickers/clipboard at all three lifecycle
  boundaries and cancellation between scan workers, including zero extra UI writes.

### Context inspector accuracy and Unicode layout

- Context headlines now identify estimator fallback explicitly and retain a valid
  measured zero. Non-finite or negative host totals are treated as unavailable.
- Layout uses Pi's display-column measurement, clipping and slicing rather than
  UTF-16 string lengths, keeping wide/combining labels within terminal bounds.
  Zero-column viewports render no rows.
- Native renderer coverage includes wide glyphs, emoji and combining marks across
  tiny and normal widths; collection tests distinguish zero, null and invalid data.

### History-search lifecycle and editor composition

- Session starts, tree navigation and shutdown close pending pickers and invalidate
  their selections. Older completion callbacks cannot overwrite a new draft or
  dismiss a newer picker.
- The Ctrl+R wrapper is installed once, captures its original editor factory and
  reads the current session context. Shutdown preserves another extension's wrapper.
- Native-import regression coverage exercises delayed selections across all three
  lifecycle boundaries and repeated starts with an intervening editor decorator.

### Turn-separator viewport bounds

- Removed the four-column minimum that overflowed tiny viewports. Rules retain
  their right margin, use one dash at width one and render no rows at width zero.
- Native Pi text rendering verifies legacy and usage-bearing entries at every
  width from zero through 160, including styled display-column bounds and no wrap.

### Monitor inspection panel

- Added `/monitor view` with searchable full commands, policy, check limits, UTC
  timing, exit status, wake reasons and pending-final-alert state. RPC emits the
  same full details; inspection does not execute commands or trigger model turns.
- Schedules and monitors now share the lifecycle-aware native snapshot panel.
  Session navigation closes it; users reopen to refresh. Command text is plain,
  with terminal controls removed; unknown exit status is distinct from zero.
- Native rendering/search tests cover long commands, narrow widths and session
  boundaries. Command dispatch tests verify full RPC details without execution.

### Monitor cancellation across pause/resume

- A check retains its cancellation identity until the process settles. Resuming
  cannot accept late output or errors from the cancelled check as a fresh result.
  No baseline, run count or alert changes until the resumed check completes.
- The model stop tool now aborts an explicitly selected in-flight command too.
- Deferred-runner tests verify both late success/error paths, no overlapping
  replacement check, fresh-result delivery and model-triggered cancellation.

### Explicit web search depth

- Rechecked the reference capability list and official Exa search contract.
  Added fast/balanced/deep choices mapping to Exa fast/auto/deep, with up to five
  bounded query variations for deep research. Firecrawl remains balanced-only.
- Explicit provider choices are preserved. Unsupported combinations and missing
  keys fail before network calls; errors never trigger a second billable request.
- Requested mode remains visible in compact and expanded results, without a
  quality guarantee. Deep calls have a 60-second bound; other modes retain 30s.
- Fixtures verify routing, filters, provenance, validation and no fallback.
  Live paid search quality and optional Mistral support remain unverified/missing.

### Working indicator choices

- Added `/working-style native|pulse|static|text` through Pi's public indicator
  API. Static and text choices remove spinner motion while preserving phase and
  elapsed time; pulse uses host animation with no additional extension timer.
- Choices persist on the session branch and apply immediately during a run.
  Navigation resets old tool/phase state and restores the destination preference;
  settlement/shutdown releases the indicator back to Pi.
- Tests cover live switching, persistence, invalid preferences, branch reset and
  no interactive UI writes in RPC/JSON mode.

### Schedule mutation serialization

- Expanded the schedule operation queue beyond management commands to include
  creation, model stops, pending delivery and turn completion. Disk snapshots
  cannot capture an earlier state change before its save/rollback has resolved.
- Fixed failed stop-all rollback erasing concurrent reminders, and later saves
  persisting reminders/cron tasks whose own creation had failed.
- Deferred-write tests compare the live task map with the reloaded disk queue
  after each failure path; existing navigation and delivery rollback tests pass.

### Native working-style and package validation

- Tested actual installed Pi working-indicator rendering inside the decorated
  editor. All four styles preserve the phase label at normal widths, static/text
  frames remain unchanged across animation intervals, and rows fit widths 1–80.
- Host implementation access is confined to an isolated test fixture; shipped
  extension code continues to use only the public working-indicator API.
- Repacked and extracted the current bundle: all 39 extensions load and shut down
  in both orders without network access. The 190-file archive includes the new
  shared panel/style modules and excludes development fixtures. Local installed
  dependencies were reused; no fresh-install or hosted-CI claim is made.

### Optional citation-based Mistral search

- Added explicit `provider: "mistral"` using the documented Conversations
  web_search tool, a bounded completion and `store: false`. No agent creation,
  conversation history, automatic provider fallback or new SDK dependency.
- Returns only web-search citation chunks. Generated answer prose is discarded,
  domain restrictions remain locally enforced, and missing citations are not
  described as proof of an empty web search. Unsupported date/depth filters fail
  before billing; key presence is visible in `/web` and `/doctor`.
- Fixture tests cover request/authentication, citation provenance, control/URL
  filtering, missing results and no paid-provider fallback. Paid runtime behavior
  and retrieval quality still require live account validation.

### Full-turn response timing

- Expanded turn summaries now show mean first-output latency and aggregate
  streaming rate, with measured-response counts. Request anchors and first
  text/thinking/tool-call deltas isolate streaming from tools and initial waits.
- Rate uses total measured output divided by total streaming duration, avoiding
  unweighted averages. Short windows, missing anchors and invalid usage remain
  unmeasured; old summaries still decode with timing unknown.
- Injected-clock tests cover multi-round tools, unequal response durations,
  missing samples, retry anchors, duplicate events and navigation cleanup.

### Native response-timing validation

- Extended the native two-round agent fixture to invoke the provider payload
  callback and stream text/tool-call deltas over measured windows. Both responses
  receive timing samples; a real asynchronous tool stays outside streaming time.
- Verified timing survives reopening the disk session and appears in the renderer
  after reload without a further model call. No network or paid provider was used.
- Active `/turn-stats` reports now say “Turn in progress” without a contradictory
  settled headline.

### Consolidated parity audit

- Mapped the reference capability catalog to current implementations and evidence,
  explicitly retaining partial code rendering/image storage, terminal integration
  and external validation gaps. The goal is not complete.
- Documented proposed public host contracts and acceptance checks for native
  fence customization and lazy image storage. No private runtime patch, host
  checkout modification or upstream communication was performed.

### Fresh consumer installation

- Added `bun run check:install`: install the packed artifact with pinned host APIs
  into a temporary consumer directory using a fresh cache and no workspace
  dependency symlinks. Explicitly rebuild/prepare node-pty, execute a real PTY
  process, then load and shut down all 39 extensions in both orders.
- Passed locally on macOS with downloaded dependencies. Temporary dependencies
  and cache are removed afterward; no publication or workspace lockfile changes.
- This closes the local clean-install gap, not Linux/Windows or hosted CI gates.

### Live macOS sleep assertion

- Added and ran an opt-in native test that launches the real caffeinate helper
  and checks only its PID's PreventUserIdleSystemSleep assertion through pmset.
- Verified acquisition, single-helper ownership and release on settlement,
  disable, session reset and shutdown. Late activity after shutdown creates no
  helper. Cleanup targets only test-owned processes; power settings are unchanged.
- Normal checks skip this OS-affecting test. This closes macOS assertion
  validation; actual hardware sleep/wake remains untested. Linux inhibition was
  subsequently removed from scope.

### Prepared isolated Linux validation

- Added `bun run check:linux` with a pinned Node/Bun container, read-only temporary
  source snapshot, container-local dependency installation, full checks and archive
  verification. Cleanup targets only this invocation's named container/snapshot.
- Syntax and the stopped-engine failure path were checked. Docker is installed,
  but the configured OrbStack socket is absent; no Linux execution is claimed.
- Startup is awaiting the user's decision because OrbStack's CLI documents that
  it also resumes machines running at the previous shutdown. No engine or user
  machine was started automatically.

### Snapshot panel navigation

- Schedule/monitor snapshots now open at their overview instead of inheriting
  live transcript following and landing at the end of the final long item.
- Snapshot headers and help omit transcript-only thinking/follow controls;
  Home/End provide top/bottom navigation without enabling a following state.
- Native fixtures verify overview visibility, search, narrow bounds and snapshot
  presentation, while existing live-transcript behavior remains covered.

### Linux runtime validation completed

- After the user started OrbStack, `bun run check:linux` passed in the pinned
  Linux ARM64 Node.js 26.8.2 container with Bun 1.3.14 and fresh dependencies.
  node-pty compiled successfully from source.
- Typechecking and the full suite passed: 1,035 tests passed, zero failed, and the
  opt-in macOS sleep assertion test was skipped as expected. Real PTY input,
  resize, EOF, exit and cleanup checks, including POSIX descendants, passed.
- The archive check loaded and shut down all 39 extensions in both orders without
  network access, using the container's installed dependencies. This supersedes
  the pending Linux execution status above; Linux desktop behavior,
  a separate consumer installation and hosted CI remain unverified.
- The owned container and temporary source snapshot were removed. OrbStack stays
  running and the downloaded image remains cached. No code fixes were needed.

### Sleep prevention scoped to macOS

- The user's Linux environment is a VM and does not need sleep prevention.
  Removed the Linux helper; the extension registers nothing on Linux.
- Doctor no longer probes or recommends a Linux sleep helper. Linux sleep
  inhibition is out of scope, not an outstanding validation requirement.
- Focused tests cover Linux no-op registration and skipped doctor helper probes;
  macOS wake-lock behavior remains covered by the existing lifecycle tests.

### Transcript search across wraps

- Search now projects logical text onto the native renderer's rows, finding
  phrases and hard-split words across visual wraps. Repeated occurrences on a
  single row are navigable; selected matches highlight every occupied row and
  keep their occurrence index across resizing.
- Source lines and messages stay separate. Ordinary Markdown uses a bounded wider
  native render to preserve visible inline formatting, list, quote and code text.
  Complex layouts that cannot map exactly retain literal row search.
- Search indexes are lazy and cached across query edits and scrolling. Native
  fixtures cover widths 8–80, formatted Markdown, repeated occurrences, and
  searching a 130,000-line result without reloading history. Shared snapshot
  panels use the same navigation and matching behavior.
- Typechecking and the full suite pass: 1,042 passed, zero failed, one opt-in
  macOS assertion test skipped. Package verification loads and shuts down all
  39 extensions in both orders without network access.

### Combined native UI review

- Added `bun run preview:ui`: load all extensions in an isolated native Pi TUI,
  drive it through a real PTY, and capture wide/narrow active, settled, hidden
  workflow and transcript-search states. A pinned development-only terminal
  emulator produces an HTML review artifact from actual terminal cells.
- The combined review exposed disappearing workflow state below card width
  thresholds. Those cards now use compact rows above the editor, with priority
  order, bounded height, overflow counts, and the existing hide/modal controls.
- Transcript and shared report panels now have a frame and padded rows, so the
  surrounding conversation is visibly separate. Their frame spans the terminal
  width to prevent stray background characters beside the modal body. Full-width
  match highlights and narrow rendering remain covered by native component checks.
- The preview uses synthetic responses and isolated configuration; no paid calls,
  notifications, Telegram messages or sleep assertions are generated. Fixture
  processes/session files are cleaned up and review artifacts stay outside Git.
- Verification passed: typechecking, 1,043 tests (zero failures, one opt-in sleep
  assertion test skipped), and the combined native preview with all 39 extensions,
  zero extension errors and zero network attempts. HTML viewing through the
  automated browser was blocked by its local-file URL policy; terminal-cell
  captures and static renderings were inspected instead.

### Actionable doctor overview and compact keyboard help

- Doctor now opens at a summary and places warnings and fixes before passed or
  inactive checks. TUI and text reports share ordering and counts; warning labels
  use the theme's warning color without treating disabled services as failures.
- Reused the shared snapshot panel for top-first navigation, appropriate controls,
  and modal cleanup. Pending checks are invalidated on session start, branch
  navigation and shutdown. Delayed old panel factories cannot replace a newer
  panel or release its command guard.
- Shared panel hints now retain close, search and scrolling guidance at narrow
  widths, adding less essential hints when space permits. All bindings still work.
- Focused native fixtures cover warnings visible on opening, discarded late
  successes/failures, replacement panel ownership, and 20/40-column keyboard help.
  The combined native preview now also inspects doctor at 100 and 60 columns.
- Verification passed: 1,045 tests, zero failures, one opt-in macOS assertion
  test skipped; typechecking and package loading in both orders also passed.
  The combined native preview loaded all 39 extensions with zero errors or
  network attempts and verified the overview, first warning and essential hints.

### Scope correction and Linux VM portability

- Recorded the user's current-host compatibility decision: custom fence/grammar
  hooks and transparent image sidecars are deferred, with no host fork planned.
- Narrowed further work to relevant existing workflows and the requested web
  research tools. Coordinated reload remains an optional development utility;
  Ghostty pane integration remains a later research track.
- Session search now tries Linux clipboard tools only for advertised Wayland/X11
  displays. Headless VM sessions use the editor fallback immediately.
- Doctor recognizes the existing terminal notification route, avoiding needless
  desktop helper recommendations. Linux sessions without a display/session bus
  show native banners as inactive rather than prescribing desktop packages.
- Added `check:linux --clean-install` to validate the packaged artifact with
  separate consumer dependencies and a real native PTY inside the Linux container.
- Verification passed on macOS and Linux ARM64: typechecking and 1,049 tests each,
  zero failures, one opt-in macOS sleep assertion test skipped. The separate Linux
  consumer install executed a native PTY process and loaded/shut down all 39
  extensions in both orders without network calls from the extensions. Package
  installation used the network; temporary dependencies, cache, container and
  source snapshot were removed. Nothing was published.

### Readable web research cards

- Compact results reserve space for source hostnames instead of letting long
  titles hide them. Very narrow views prioritize the source; truncated hostnames
  have an ellipsis. Source links reuse the existing hyperlink mode and keep full
  URLs/snippets in expanded output.
- Empty results distinguish no matches, excluded rows and absent model-selected
  citations. Failures expose a bounded cause immediately; page continuations put
  the next offset first so it survives narrow card padding.
- Native visual inspection found truncation resetting a card's background. The
  foreground-only web renderer now preserves the surrounding success/error
  background after clipping, without changing host internals.
- Public native tool cards at 24, 40 and 80 columns verify source visibility,
  continuation offsets, error causes and expanded content. Terminal-cell checks
  verify uniform card backgrounds; width sweeps cover controls, Unicode,
  malformed saved URLs and hyperlink closure. Static captures were inspected with
  the repository theme; actual terminal clicking and font fallback remain separate.
- Full checks pass: typechecking, 1,049 tests, zero failures and one opt-in macOS
  assertion test skipped. The archive includes the shared web rendering module;
  all 39 extensions load and shut down in both orders. Search execution and
  billing behavior are unchanged; no paid requests were made.

### Consistent inspection for existing loops

- Added `/loop view` using the same searchable snapshot panel as monitors and
  schedules. It shows complete prompts, cadence, remaining iterations, queued or
  running state, wake/expiry times and pacing/pause reasons. The short status
  listing and scheduling behavior remain unchanged.
- Default-prompt inspection uses the existing trust-aware prompt resolver and
  distinguishes current configuration from a running iteration or finished
  history. Viewing performs no scheduling or state writes. Native tests verify
  full-prompt search, refresh after prompt-file changes, project-trust fallback,
  narrow rendering and closure at session/navigation boundaries.
- The combined native TUI preview includes a paused loop at 100 and 60 columns;
  all 39 extensions load with zero errors and zero network attempts. The latest
  macOS and Linux ARM64 full suites each pass 1,053 tests, zero failures and one
  opt-in sleep-assertion skip. The Linux archive check loads all 39 extensions in
  both orders, including the new shared loop panel. Owned test containers and
  temporary source snapshots were removed afterward.

### Earlier live research blocker — resolved

- Initially treated missing Exa, Firecrawl and Mistral keys as preventing live
  search validation. The user selected Exa and pointed out its keyless access.
  Official documentation and a live MCP handshake confirmed free, rate-limited
  anonymous access; the earlier assumption was incorrect.
- Keyless Exa is now implemented and verified live. No API key, account setup or
  billing configuration is required for the default path. Keyed/paid service
  validation remains unperformed, but is not a prerequisite for keyless search.

### Provider warnings and request deadlines

- Reviewed the search adapters against the current official Exa, Firecrawl and
  Mistral documentation. Firecrawl's successful-response `warning` field was
  being discarded. It now survives normalization, appears in compact cards and
  expands to bounded, control-stripped provider text. Empty warned responses no
  longer imply that the web has no matches; usable results remain available.
- Firecrawl requests now specify its documented 25-second server timeout inside
  the existing 30-second client deadline. Warnings do not cause automatic retries
  or provider fallback. Server cancellation and billing remain provider-owned.
- Focused fixtures cover warnings with and without results, malformed/absent
  warnings, sanitization, narrow cards and exactly one request. Full macOS checks
  pass: typechecking, 1,055 tests, zero failures and one opt-in sleep-assertion
  skip. The 198-file package loads all 39 extensions in both orders. The latest
  Linux full-suite result remains 1,053 passed, before this provider-only change;
  no new Linux run or live paid request is implied.
- Contract references: [Exa search](https://exa.ai/docs/reference/search),
  [Firecrawl search](https://docs.firecrawl.dev/api-reference/endpoint/search),
  [Mistral web search](https://docs.mistral.ai/studio/agents/agent-tools/websearch)
  and [Conversations API](https://docs.mistral.ai/api/endpoint/beta/conversations).

### Exa without configuration

- Exa is always the default provider. Without `EXA_API_KEY`, searches use its
  documented hosted MCP endpoint; with a key they use the direct API. Firecrawl
  and Mistral require explicit selection, so an unrelated key cannot change the
  default or create an unexpected charged fallback.
- Balanced and fast modes, domain restrictions and date windows work keylessly.
  Deep mode requires a key because the live MCP search schema does not offer it.
  The advanced search tool provides structured source records and bounded
  highlights; the extension does not extract URLs from generated prose.
- Added bounded JSON/SSE response handling, protocol negotiation, isolated
  per-search sessions, cancellation and session cleanup. Exactly one search is
  submitted; errors never retry or switch transport/provider automatically.
- `/web`, `/doctor`, tool descriptions and source cards distinguish keyless access
  from configured keys. Missing keys no longer produce a configuration warning.
- Live Node.js checks with an empty credential environment returned ax's official
  site in balanced mode and Exa-domain sources within a requested date window in
  fast mode. Three anonymous searches total included the initial contract probe.
  No account credentials or private content were sent. These samples verify
  functionality, not an overall retrieval-quality ranking.
- macOS and Linux ARM64 checks pass: typechecking, 1,064 tests each, zero failures and one opt-in sleep
  assertion skip; the 199-file archive loads all 39 extensions in both orders.
  The native UI preview passes at both widths with zero extension errors or
  network attempts and shows healthy keyless search configuration.
  The owned Linux test container and temporary source snapshot were removed.
- References: [Exa hosted MCP](https://exa.ai/docs/get-started/exa-mcp),
  [MCP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
  and [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).


### Accepted comparative-review follow-up

The five recommended workstreams are implemented and verified in the
[follow-up report](review-follow-up.md). It supersedes earlier access/persistence
behavior and historical test counts above: account search now requires explicit
`PI_EXA_ACCESS=api-key`, bounded Exa rejection retries are supported, and child
conversations survive reload/quit with explicit stopped restoration. The report
records the current 210-file package, 14-tool default, native UI evidence and
final macOS/Linux results. Current-host compatibility and deferred Ghostty/image
storage/custom fence work remain unchanged in scope.
