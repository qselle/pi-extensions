# Capability parity audit

Historical acceptance record. See [setup decisions](setup-design.md) for the
current 38-extension inventory, Telegram topics, cleanup and final validation.

Reviewed against the reference feature catalog and the current working tree on
2026-09-20. This is a capability assessment, not a claim that every implementation
is better. The delivery history is in [the improvement plan](improvement-plan.md).

The subsequent [comparative review](comparative-review.md) ranks actual strengths,
remaining gaps and unnecessary scope. It also records newly reproduced context
continuity issues and date-filter hardening work, now addressed in the
[accepted follow-up](review-follow-up.md). Delivery acceptance below is
not a clean code-review verdict or a claim of competitive superiority.

The user narrowed scope on 2026-09-20 to relevant improvements, primarily to
existing extensions, while keeping current-host compatibility. This catalog is
an inventory, not a backlog requiring every capability to be reproduced. The
[current scope](improvement-plan.md#current-scope) governs further work.

## Delivery acceptance

The requested implementation pass is complete under the user's current-host and
relevance constraints. Acceptance is based on the specific behavior below; it
does not claim universal superiority over another collection or validated behavior
for optional services that were not exercised.

| Requirement | Accepted evidence |
|---|---|
| Start with a plan and improve UI first | The dated improvement plan records the UI foundation before research features; footer, working-state, tool-card and workflow changes have focused native tests |
| Apply useful lessons to existing extensions | The lessons table links readability, navigation, lifecycle and portability changes to their regression coverage; catalog coverage is not a requirement |
| Improve the combined interface | Native 100/60-column captures show persistent active-work summaries, context visibility, framed inspection panels and readable keyboard help; the final terminal-cell visual review also includes the keyless source card |
| Add useful web research | The extension's default keyless Exa path returned live balanced and fast results; domain/date handling, source attribution, bounds and cancellation are covered; ax Markdown/outline/extraction were exercised live |
| Make Exa usable without setup, with an optional key | Empty-credential live searches work; fixtures verify that explicit `PI_EXA_ACCESS=api-key` plus a configured key selects the direct API and failures never silently change access paths/providers; `/web` and `/doctor` recognize keyless configuration |
| Preserve current-host compatibility | Typechecking and both native loader orders pass on pinned Pi 0.85.1; production extensions use public APIs; the host-dependent gaps remain explicitly deferred |
| Support macOS and the Linux VM | Both full suites pass, with real pipe/PTY lifecycle coverage and both package load orders; isolated consumer installations also verified runtime dependencies |
| Keep Linux sleep prevention out of scope | Production registration returns immediately on Linux; focused tests verify no hooks/helper checks, while macOS assertion acquisition/release was separately exercised |
| Research Ghostty for later | The installed scripting dictionary and official documentation support the feasibility study, concrete workflow proposal and identified process-accounting limits; no pane integration is claimed |

Latest checks: 1,083 tests passed on macOS, zero failures, including its native
power-assertion test. Linux ARM64 passed 1,082 tests, zero failures, with only the
macOS-specific assertion skipped. The archive contains 210 files and loads/shuts
down all 39 extensions in either order. Combined native UI checks report zero
extension errors and zero network attempts. Visual review used captured terminal
cells with synthetic data; normal terminal font rendering and personal visual
preference remain distinct from those captures.

## Evidence and status

“Local” means implementation plus local automated/runtime evidence. It does not
establish paid-service behavior, hosted CI success or visual preference. The most
recent macOS/Linux counts and new continuity, search and UI evidence are in
[the follow-up report](review-follow-up.md). Counts alone are not parity evidence.

| Capability | Implementation and evidence | Status / remaining acceptance |
|---|---|---|
| Editor accents | [codex-prompt](../extensions/codex-prompt/README.md), native editor input/cursor/paste tests | Local; theme, fixed and thinking accents |
| Editor companion | [cat-buddy](../extensions/cat-buddy/README.md), native decorator-order tests | Local; live appearance across terminal fonts still needs review |
| Tool blocks and inline changes | [tool-render](../extensions/tool-render/README.md), native renderer and combined-loader tests | Local; compact grouping, expanded output and failures |
| File hyperlinks | [hyperlinks](../extensions/hyperlinks/README.md), URI/platform parsing tests | Local; actual click-through remains unverified |
| Code fences | [code-blocks](../extensions/code-blocks/README.md), native Markdown tests | Partial: captions/aliases supported; custom fence layout and Zig grammar deferred by the user's current-host compatibility choice |
| Footer and context pressure | [footer](../extensions/footer/README.md), native footer tests | Local; narrow widths and unknown measurements covered |
| Working indicator | [working-status](../extensions/working-status/README.md), native indicator/editor tests | Local; phases, elapsed time, native/pulse/static/text styles |
| Work-block separators | [turn-separator](../extensions/turn-separator/README.md), native width sweep | Local; full-turn summary is separate |
| Full-turn accounting | [turn-stats](../extensions/turn-stats/README.md), native tool loop and disk reload | Local; usage, outcomes, latency and streaming windows |
| Overlay composition | [overlay-stack](../extensions/overlay-stack/README.md), allocation tests and native UI preview | Local; constrained-height fairness, short-card reclamation and compact summaries for small viewports |
| Naming and rename | [session-title](../extensions/session-title/README.md), generation/cancellation tests, Herdr Tab link | Local native Pi and socket tests cover tab linking, reload, manual overrides, and pane targeting; live Herdr UI and title-model response quality remain unmeasured |
| History and saved-session search | [history-search](../extensions/history-search/README.md), [session-search](../extensions/session-search/README.md) | Local; stale navigation, scan cancellation and immediate headless Linux clipboard fallback covered |
| Rewind | [rewind](../extensions/rewind/README.md), native fork test | Local; restores prompt, preserves original history; no filesystem rollback |
| Transcript navigation/performance | [transcript](../extensions/transcript/README.md), native large-transcript test | Local cached rendering and occurrence search across wraps, with conservative row fallback for complex Markdown layouts; not a patch to Pi's global ANSI renderer |
| Context inspection | [context](../extensions/context/README.md), native collection/rendering tests | Local; estimates distinct from measured zero, Unicode bounds |
| Durable context management | [context-journal](../extensions/context-journal/README.md), native rollover tests | Local opt-in notes/history/rollover; no paid-model continuity evaluation |
| Handoff | [handoff](../extensions/handoff/README.md), native persistence/new-session tests | Local additional capability; explicit review and fresh context |
| Image history/storage | [image-history](../extensions/image-history/README.md), native retrieval/context tests | Partial: reversible input deferral; transparent disk sidecars and lazy loading deferred by the user's current-host compatibility choice |
| File-change summary | [file-changes](../extensions/file-changes/README.md), concurrent baseline/diff tests | Local for edit/write tools; shell/rename changes are not tracked |
| Goals and nested plans | [goal](../extensions/goal/README.md), [plan](../extensions/plan/README.md), native plan test | Local; semantic goal completion remains the agent's responsibility |
| Questions and side chat | [questions](../extensions/questions/README.md), [side-chat](../extensions/side-chat/README.md), native lifecycle tests | Local; terminal-manager blocked-state reporting is not integrated |
| Child agents | [subagents](../extensions/subagents/README.md), native context/navigation/transcript tests | Local; isolated sessions and structured results |
| Managed background commands | [background-jobs](../extensions/background-jobs/README.md), native bash/PTY tests | macOS and Linux ARM64 container pipe/PTY and POSIX cleanup verified; Windows remains unverified |
| Visible terminal panes and titles | [Ghostty study](ghostty-integration.md) | Research completed for installed macOS dictionary; no pane-control implementation or app runtime test |
| Desktop notifications and Telegram | [notify](../extensions/notify/README.md), [telegram](../extensions/telegram/README.md) | Lifecycle/formatting tests; real delivery and permission behavior remain unverified |
| Fast provider mode | [fast-mode](../extensions/fast-mode/README.md), native adapter request test | Local request serialization; account eligibility and actual service tier unverified |
| Prevent sleep | [prevent-sleep](../extensions/prevent-sleep/README.md), process lifecycle and opt-in runtime tests | Live macOS assertion acquisition/release verified; intentionally no-op on Linux |
| Web search | [web-search](../extensions/web-search/README.md), provider fixtures, live keyless requests and native card/cell checks | Exa defaults to keyless access, verified live in balanced/fast modes with domain/date controls; keyed deep mode and alternative providers remain optional; paid retrieval quality and actual click-through unverified |
| Web reading | [web-search](../extensions/web-search/README.md), ax process/live GET and native card checks | ax 0.1.25 Markdown/outline/extract verified locally; continuation remains visible in narrow cards; arbitrary-site coverage not claimed |
| Diagnostics | [doctor](../extensions/doctor/README.md), native renderer, bounded probes and combined UI preview | Local overview with warnings first, snapshot controls, stale-result guards and terminal-aware notification checks; missing keys are valid for default Exa search; connectivity/credits are not probed |
| Usage export | [usage-export](../extensions/usage-export/README.md), export tests | Explicit local JSON/CSV with child accounting; no automatic external collector |
| Automation | [loop](../extensions/loop/README.md), [monitor](../extensions/monitor/README.md), [schedule](../extensions/schedule/README.md) | Existing workflows improved with searchable full-detail inspection for all three; native loop view verifies no state writes/wakeups, prompt trust rules and lifecycle cleanup |

## Deferred scope

- Custom fence rendering/grammar registration and transparent image storage need
  public host support and are deferred by user choice. See
  [the compatibility decision](host-api-gaps.md#compatibility-decision).
- Visible terminal workflow implementation remains a later research track.
  Ghostty pane creation alone cannot establish process ownership, captured output
  or exit status.
- Optional additions such as coordinated reload and provider fast mode do not
  drive the current UI and portability work.

## Validation limits

1. Live validation of paid search and fast-mode eligibility, notifications,
   Telegram and hyperlinks. Fixtures establish handling, not
   external service results. No live messages or paid calls were made for this audit.
   Keyless Exa is separately verified with public-documentation queries; these
   establish working search and filters, not general retrieval superiority.
2. Linux/macOS hosted CI and Windows validation. The workflow defines Linux/macOS
   jobs but no remote run of this working tree has been established. An isolated
   macOS consumer install now passes with fresh dependencies, a real native PTY
   command, and both extension load orders. Linux ARM64 container validation also
   passes with freshly installed source dependencies, native node-pty compilation
   and the full suite. A separate Linux consumer installation also passes with
   fresh dependencies, a real native PTY process, and both packaged extension load
   orders. Windows remains unverified and outside the current portability scope.
   The container does not validate Linux desktop integration. Sleep prevention is
   macOS-only and requires no Linux validation.
3. Human visual review of the combined interface in normal use, plus comparable
   performance/retrieval measurements before claiming overall superiority.
   `bun run preview:ui` now verifies the combined native TUI at 100 and 60 columns
   with synthetic responses and captures review artifacts. It does not establish
   a terminal application's font/graphics rendering or human visual preference.

The latest combined preview includes paused-loop inspection and healthy keyless
search diagnostics in both widths, with all 39 extensions loaded, zero extension
errors and zero network attempts. The latest Linux suite includes the keyless
transport, web-card and loop-panel changes. Both platforms verify the 210-file
archive in both load orders.
No hosted CI or live paid-service result is implied by those local checks.

The delivered work follows the user's narrowed scope. Deferred features are not
implemented parity, and local checks do not establish overall superiority or
unverified external behavior.


The accepted [review follow-up](review-follow-up.md) adds current-cycle context
checkpoints, visible history cursors, live shell/side-chat output, compact plan
receipts, optional transcript telemetry, explicit Exa access, remote page/PDF
reading, stopped child restoration and queue-only messages. Shared helpers now
ship under `lib/`; the supported Pi line is 0.85.x from 0.85.1 onward. Fresh model
tool exposure falls from 31 tools / 20,405 description-and-schema bytes to 14 /
14,091 bytes. This measures tool overhead, not retrieval or reasoning quality.
