# Comparative review — 2026-09-20

Historical research. The current scope and verification are in
[setup decisions](setup-design.md); catalog parity is not the target architecture.

This is the review snapshot from before the accepted implementation pass.
The five recommended workstreams are now implemented; see
[review follow-up](review-follow-up.md) for current behavior, verification and
remaining comparison limits. Findings and recommendations below are retained as
the rationale, not as a list of still-open bugs.


Our strongest improvements are workflow inspection, persistent side chats, explicit handoffs, narrow-terminal context visibility, and tested macOS/Linux process behavior. The reference remains ahead in tool presentation, web research breadth, child-agent continuity, and image-heavy session handling. We have not established overall superiority. The next pass should deepen these useful workflows and simplify the default experience.

This review covers all 39 local extensions and the relevant reference capabilities. It reviews the current uncommitted implementation, not just repository HEAD. The reference source was inspected at revision `f266541b4264610ac136eacfd4264e73e284d418`; it was not installed or executed. Comparisons below distinguish source-supported capabilities from runtime observations. Reference paths are relative to that reviewed snapshot. No reference implementation was copied.

The [delivery audit](parity-audit.md) records implementation and validation, not a competitive quality ranking. This review supplements it and identifies remaining work. Current-host compatibility, Exa as the chosen provider, macOS plus a Linux VM, and no Linux sleep prevention remain the governing requirements.

## Findings to fix first

### 1. P2 — Automatic context rollover accepts an old checkpoint

In [rollover.ts](../extensions/context-journal/rollover.ts), `ready()` at line 28 checks only whether any note exists. The idle-input handler at line 93 can trigger a no-summary rollover at high context usage without a new `context_rollover` request or a fresh note. A checkpoint from before substantial subsequent work therefore satisfies the gate.

A focused hook probe supplied one old note, 95,000 used tokens in a 100,000-token window, and a new input event. It received a no-summary compaction despite no checkpoint update. History remains on disk, but the model can lose recent objectives, decisions and unfinished work from its immediate context. This is a continuity defect, not deletion of the original transcript.

Require a checkpoint revision associated with the current rollover cycle and recent work before automatic rollover. When it is stale, preserve the current context or use the native summary path. Freshness cannot prove a note is complete, but it can prevent accepting an arbitrarily old note. Add a regression covering two rollover cycles and intervening work without note updates.

### 2. P2 — History pagination instructions refer to metadata the model cannot see

[context-journal/index.ts](../extensions/context-journal/index.ts), lines 52–58, tells the model to use `nextBefore`, but returns it only in `details`. Pi's current OpenAI Responses adapter serializes tool `content`, not this UI metadata. A two-message probe with `limit: 1` returned the second message in content and the continuation only in details.

The model can infer the last entry ID, but the advertised continuation contract is incomplete. Put the cursor and an explicit continuation/end indication in model-visible content. Also distinguish an exhausted scan from a page that stopped at its limit; `historyMatches()` currently sets a cursor even after reaching the beginning. Test the registered tool result, not only the search helper.

### 3. P2 hardening — Date constraints are sent upstream but not enforced on results

[web-search/client.ts](../extensions/web-search/client.ts) locally checks domains and duplicates but does not compare returned publication dates with the requested range. A mock Exa response containing a 2020 result and a 2026 result retained both for a 2026-only query. Both access paths use this normalization.

The output already discloses that date matching depends on the provider, so this is a robustness gap rather than a hidden guarantee violation. The reference's `web-search/router.ts` rejects known out-of-range dates after every provider response. Do the same, report exclusions, and explicitly label unknown dates rather than inventing them. Cover timezone boundaries and partial dates.

### 4. P3 — Managed shell execution suppresses partial foreground output

The registered `bash` implementation in [background-jobs/index.ts](../extensions/background-jobs/index.ts), lines 119–146, waits before returning and ignores the update callback. With a long `yield_ms`, the transcript gets no intermediate command output during that wait. The job viewer and later completion invalidation do not replace foreground streaming.

The reference's `background-jobs/index.ts` publishes partial results while waiting. Add bounded, coalesced updates and elapsed/status feedback, with cleanup on cancellation. This matters more than adding another job command.

## Where each implementation is stronger

| Area | Reference advantage | Our advantage / qualification | Recommendation |
|---|---|---|---|
| Tool presentation | Consistent compact layout across tools, readable command blocks, intent headlines, wrapped errors and actual expansion-key hints | Native tool parameters remain simpler; bounded previews, exploration grouping and line-numbered diffs already work | Unify our presentation. Intent headlines can be optional; a mandatory reasoning argument on every tool is unnecessary |
| Code fences | Custom rules, labels, copy-friendly code lines and extra language highlighting | Public Markdown transformation handles captions and language aliases without prototype replacement | Real visual gap; defer the unavailable rendering/grammar hooks rather than patch Pi |
| Footer | A cohesive visual vocabulary and integrated status badges | Our width priorities retain model/context information longer; unknown context stays unknown; auxiliary status has its own row | Keep our information priorities and refine density/contrast |
| Web search | More filters, bounded retries, anonymous-first Exa even with a configured key, provider-attempt timing and credits | Explicit fast/balanced/deep requests; no automatic provider switching; structured keyless results; response bounds and cancellation | Keep Exa central. Add useful Exa controls and an explicit access policy |
| Web reading | Remote page/PDF opening and fallback after failed local extraction | Dedicated ax Markdown, outline and selector extraction; visible continuation and honest completeness limits | Keep ax first. Add an explicit Exa remote fallback for PDFs and failed public-page reads |
| Child agents | Checkpoint/restore across reload, retained unread finals, interim reports, queue-only messages, separate follow-ups and richer wait conditions | Configurable capacity, per-child model/thinking overrides, bounded RPC and process-tree cleanup | Highest-value missing workflow capability: recover children without automatically restarting work |
| Side chats | A small, lightweight one-off interaction | Multiple persistent, branch-aware chats; retry, stop, context choice and explicit promotion | Keep ours. Streaming is a useful polish improvement; no need for another chat system |
| Transcript and history | Shared visual styling with its tool renderers | Searchable cached transcript view, branch selection, project-scoped session search, stale-action guards and headless clipboard fallback | Keep; do not claim a speed win without comparable measurements |
| Context management | Similar note/history/rollover approach | Bounded branch-aware notes and a separate reviewed handoff workflow | Fix checkpoint freshness and pagination; evaluate continuity with real tasks |
| Diagnostics | Broader host settings/model/auth checks, duplicate bindings and startup diagnostics | Read-only dependency checks, explicit unverified states and actionable local setup guidance | Add host/model/binding coverage where public APIs support it; patch-cache diagnostics are irrelevant here |
| Image-heavy sessions | Content-addressed image sidecars, lazy loading and global rendering caches | Original sessions remain standalone; optional model-input deferral is reversible | Reference is ahead on storage/rendering capabilities. Our image-history is not equivalent |
| Portability | PTYs use system utilities, avoiding a native npm addon | Real Node PTY resizing/input/EOF and lifecycle checks on macOS/Linux ARM64; pipe operation under Bun | A tradeoff: ours adds native installation cost and does not support PTY under Bun |

The reference's image sidecars require carrying additional files when moving sessions and have export limitations. Its custom fence/global rendering features replace host internals. Those costs matter under our current-host constraint; they do not erase the capability gap. See [host API gaps](host-api-gaps.md).

Its web routing also automatically tries configured alternatives and may consume account credits. Our explicit provider choice is more predictable. However, ours immediately selects the account API when `EXA_API_KEY` exists. That can consume a free-tier allowance or paid credits even while anonymous access would have sufficed. Prefer an explicit `keyless`, `api`, or opt-in fallback policy; do not silently turn possession of a key into unlimited permission to spend.

Reference source supporting these distinctions includes `better-native-pi/index.ts`, `code-blocks/`, `web-search/router.ts`, `web-search/providers/exa.ts`, `subagents/index.ts`, `subagents/persistence.ts`, `side-chat/index.ts`, `doctor/`, `image-store/`, and `cached-line-resets/` under `extensions/`.

## UI review

The existing native 100-column and 60-column captures show a usable foundation: the editor is clear, compact workflow state survives narrow widths, and the footer keeps context pressure visible. They also show why passing width tests is not sufficient:

- The plan can appear both as a full tool result and as an overlay. Keep a short update receipt when the persistent card already provides the plan.
- Tool, plan and web results use different background/framing conventions. Define one headline, one secondary metadata row, one expansion hint and shared spacing.
- Many useful details are dimmed together. Reserve stronger contrast for the current action, source identity and failures; de-emphasize only secondary telemetry.
- Work-block separators, settled-turn summaries and footer usage overlap. Keep the underlying accounting, but make transcript telemetry compact or configurable.
- Collapsed web cards emphasize titles and hosts. Offer enough URL/path/date information to distinguish sources, with a reliable expansion key hint. Preserve host visibility at small widths.
- Foreground job output and side-chat answers should feel live. Add streaming where supported before adding more decorative motion.

The reference has more developed presentation here, judged from its renderer source and documented examples. It was not run side by side in the same terminal. Our captures use synthetic data and reconstructed terminal cells; neither those images nor source inspection establish human preference or a latency win.

## Default complexity and maintenance

A fresh isolated Pi 0.85.1 session loading this package registered **39 extensions, 43 commands and 31 active tools**, with **20,405 bytes** of JSON-serialized active tool names, descriptions and parameter schemas. That byte count is not a token estimate and excludes other prompt content. Loading made no network requests and reported no extension errors.

Seven job tools are active before any job exists; `job_start` overlaps the managed `bash` entry point. Goal updates and automation controls also appear before their workflows are active. The reference keeps its three job controls inactive until the first yielded command. Follow that principle: expose operational tools when useful, preserve configured selections, and keep commands available for discovery. Memory, image-history and context-journal already demonstrate opt-in activation locally.

Provide a documented lean setup using Pi's existing extension selection, plus optional workflow and development groups. A new profile manager is not required. Keep internal utility files importable even when their owning extension is disabled.

The local code has 43 distinct static cross-extension import pairs. Pure output sanitization/redaction helpers live under background-jobs, and general viewing helpers live under transcript. Move genuinely shared utilities to a neutral internal module with a narrow API. Do not turn every helper into an extension dependency or collapse all extensions into a monolith. Any move must update package inclusion and clean-install checks.

The public Pi peers currently use `*`, while validation is pinned to 0.85.1 and several extensions depend on its newer APIs. Document and declare a supported host baseline. A successful pinned-host run does not prove compatibility with every older or future host. Similarly, distinguish implemented Windows branches from verified platform support.

## Keep, improve, or make optional — complete local inventory

“Keep” means useful in the requested scope, not mandatory in every session. A standalone reference equivalent is not a requirement.

| Local extension | Assessment and next action |
|---|---|
| background-jobs | Keep. Stream foreground updates; activate control tools on demand; retain PTY lifecycle guarantees |
| cat-buddy | Optional appearance preference. Keep configurable; further animation is low priority |
| code-blocks | Keep public caption/alias behavior. Custom presentation remains an explicit compatibility gap |
| codex-prompt | Keep. Public editor decoration, accent control and input compatibility are useful |
| context | Keep. Useful breakdown with measured versus estimated usage; use it to measure default tool overhead |
| context-journal | Keep opt-in. Fix the two context findings before expanding rollover behavior |
| doctor | Keep. Broaden host/model/duplicate-binding checks and retain honest local-only wording |
| fast-mode | Optional account-specific control. Disabled by default; no further priority without actual use |
| file-changes | Keep. Clearly limited to edit/write activity; consider shell-change reconciliation only if this limitation causes problems |
| footer | Keep. Preserve narrow-width context visibility; reduce duplicated telemetry elsewhere |
| goal | Keep for explicit goals. Completion checks and interruption handling are useful; never infer semantic success solely from checkboxes |
| handoff | Keep. Reviewed fresh-session transfer is distinct from automatic context rollover |
| history-search | Keep. Prompt recall differs from saved-session search; share picker primitives |
| hyperlinks | Keep. Actual terminal click-through remains an acceptance check; avoid terminal-specific assumptions |
| image-history | Optional. Useful input deferral, but not image storage optimization; do not describe it as sidecar parity |
| loop | Keep optional model-paced/cadenced work. Defer controls until relevant |
| memory | Keep opt-in cross-session notes. Distinct from session-local context notes; no automatic transcript collection needed |
| monitor | Keep optional command-result monitoring. Its cheap external checks differ from model-driven loops |
| notify | Keep. Focus/goal suppression is useful; verify actual macOS delivery and Linux VM expectations |
| overlay-stack | Keep shared composition. Reduce repeated plan content and keep modals unobscured |
| plan | Keep. Nested progress and scope preservation are useful; make update receipts compact |
| prevent-sleep | Keep macOS-only. Linux remains a complete no-op as requested |
| questions | Keep. Structured questions, masked secrets and cancellation handling are relevant; terminal-manager adapters are not needed now |
| rewind | Keep. Search and draft restoration are useful; explicitly never imply filesystem rollback |
| schedule | Keep optional reminders/calendar rules. Do not merge these semantics into loops merely to reduce directory count |
| session-search | Keep. Project scope, cancellation and VM clipboard fallback are strengths; lexical search is sufficient until proven otherwise |
| session-title | Keep conservative defaults. Reference titles follow evolving outcomes; ours is cheaper/simpler but can become stale after topic changes. Consider opt-in refresh |
| side-chat | Keep. Persistent multi-chat workspace is a local strength; stream answers and preserve independent cancellation |
| subagents | Improve next. Persist resumable child state and unread results; distinguish queue-only messages from work-starting follow-ups |
| telegram | Optional remote service. Existing functionality is enough; do not grow it without a requested remote workflow |
| tool-render | Core UI priority. Consistent status, command layout, error detail, wrapping and expansion controls |
| transcript | Keep. Shared searchable inspection is useful; benchmark large sessions before claiming faster rendering |
| turn-separator | Optional presentation. Combine or simplify visible usage when turn-stats is enabled |
| turn-stats | Keep accounting and inspection. Make the automatic visible entry configurable; failures deserve semantic contrast |
| usage-export | Keep explicit local export. No background analytics collector needed |
| verify | Keep optional project checks. Avoid duplicate expensive validation when a project already handles it |
| web-search | Core feature priority. Exa policy/retries/filters, ax-first reading and explicit remote/PDF fallback |
| working-status | Keep one clear phase/timer. Coordinate with editor/footer so activity is not repeated unnecessarily |

## What we do not need

- A full copy of the reference catalog, more search providers, or automatic paid fallback. Exa plus ax is the chosen baseline; Firecrawl/Mistral adapters can remain optional legacy choices without further investment. No need to add TinyFish for feature-count parity.
- Terminal-manager-specific process/tab integrations. Existing terminal titles and attention state are useful; Ghostty pane control stays in the [later study](ghostty-integration.md).
- Linux sleep inhibition, a daemon scheduler, a new telemetry backend, or automatic external memory collection.
- Private Markdown/TUI/storage patches to obtain cosmetic parity. Keep host-dependent improvements pending public support.
- Mandatory code changes based only on raw test counts, file counts or extension counts. Nor should useful existing automation be deleted merely because it has no reference counterpart.

## Recommended next pass and acceptance

1. **Correctness:** fix checkpoint freshness and model-visible history continuation; locally enforce known publication dates. Regress the observed failures at the registered-tool/hook boundary.
2. **UI first:** unify existing tool/web/plan presentation, stream foreground output, make transcript telemetry configurable, and improve error/URL visibility. Review real 60/100-column terminal sessions, long commands, Unicode and failures.
3. **Exa depth:** explicit anonymous/account access policy, bounded retry within one deadline, exclusion filters and independent date bounds, then remote PDF/page fallback behind the same explicit policy. Categories/freshness follow only where the research workflow benefits.
4. **Child continuity:** checkpoint children on reload/quit, restore them stopped, retain undelivered finals, and add queue-only messaging. Verify no duplicate delivery, unwanted restart, or replay of cancelled input.
5. **Simplification:** activate workflow tools only when needed, document a lean installation, extract shared helpers, and declare the supported host baseline. Preserve full package and load-order checks.

Before claiming the web workflow is better, run the same small research set against comparable routes: primary documentation, recent dated news, domain inclusion/exclusion, a public PDF, blocked/empty HTML, long-page continuation, cancellation and shared quota exhaustion. Measure useful sources, unsupported claims, latency and account usage. Successful transport tests do not measure retrieval quality.

Before claiming the interface is faster, compare startup, large-transcript opening/search, resize and long-output updates using the same machine/session data. Image sidecars and global caches must be measured separately from our local transcript-view cache.

## Validation boundary

This review freshly exercised the isolated public loader and focused offline probes for tool activation, history output, date normalization and stale-checkpoint rollover. All probes made zero network requests. Reproduction script/output are temporary review artifacts; the observations above contain the durable evidence. No production behavior was changed by this review.

The existing macOS and Linux ARM64 logs were inspected: each records 1,064 passes, zero failures and one opt-in sleep-assertion skip. Package checks record all 39 extensions loading in both orders. These suites were not rerun merely to reproduce the same counts. Native UI captures were also inspected.

The reference was source-reviewed, not runtime-benchmarked. Live paid APIs, notification delivery, Telegram, actual hyperlink clicks, Windows and hosted CI remain unverified. Previous live anonymous Exa/ax checks establish working sample requests, not universal coverage or better research quality.
