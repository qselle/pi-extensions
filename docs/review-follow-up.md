# Review follow-up

This records the earlier improvement pass. Subsequent cleanup, Telegram session
topics and current verification are documented in [setup decisions](setup-design.md).

Implemented from the accepted [comparative review](comparative-review.md),
2026-09-20. The scope uses public Pi APIs, Exa as the primary research provider,
macOS/Linux VM support, and no Linux sleep prevention. Ghostty pane control and
host-dependent Markdown/image storage changes remain deferred.

| Work | Delivered behavior and evidence | Status |
|---|---|---|
| Context continuity | Fresh note checkpoint required each rollover cycle; model-visible continuation/end; real Pi persistence across repeated rollovers | Complete |
| Search correctness | Local known-date filtering, UTC boundaries, unknown/partial dates labelled, independent date bounds and domain exclusions | Complete |
| UI consistency | Shared tool/web/plan presentation, wrapped errors and source URLs, configured expansion keys, live shell/side-chat output, compact/full/hidden telemetry; native 60/100-column captures | Complete |
| Exa/ax depth | Explicit keyless/account policy, bounded rejection retries, categories, ax-first reading and explicit remote page/PDF extraction; deterministic transport cases and live keyless checks | Complete |
| Child continuity | Saved conversation leaves, stopped restoration, unread finals, queue-only messages, explicit resume, cancellation without replay; registered extension reload and disk reopening verified | Complete |
| Lean defaults | Workflow controls activate when used; fresh tool count 31 → 14; documented selection through existing Pi configuration | Complete |
| Maintenance and diagnostics | Shared `lib/` utilities, Pi 0.85.1–0.85.x peers, host/settings/model/binding diagnostics; package inclusion and clean consumers verified | Complete |
| Final validation | macOS/Linux suites, native PTY, both packaged load orders, UI captures, live anonymous research and large history probe | Complete |

## Behavior worth knowing

- Exa is keyless by default even if `EXA_API_KEY` exists. Set
  `PI_EXA_ACCESS=api-key` alongside the key to opt into account usage. The
  extension cannot guarantee account requests remain within free credits.
- Exa retries one explicit HTTP 429 rejection; keyless requests also allow one
  502/503/504 retry, under the same deadline. Long cooldowns and ambiguous network
  failures are surfaced. Access policy and provider never switch automatically.
- `web_read` defaults to local ax. Explicit `reader: "exa"` sends the public URL
  to Exa for a bounded remote excerpt, including PDFs. It has no CSS extraction or
  continuation. Provider text is untrusted; redirect identity and completeness
  are not invented from prose. PDF tables/figures still require verification.
- `/turn-stats compact|full|hide` controls both transcript summaries and separator
  detail without disabling accounting. `/turn-stats` retains full inspection.
- Child conversations live alongside the persisted parent session. Reload/quit
  stop their processes; `send` resumes explicitly. `queue` never starts or steers
  work; `read` retrieves the latest output. Historical branch copies remain for
  recovery when the current copy is closed. In-memory parents are not durable.
- Late events from an exited child process cannot settle or overwrite its resumed replacement.
- The child work also corrected summary-only context transfer: public Pi session
  entries must be materialized before another process opens the child file.
- `job_start` remains a registered compatibility alias, inactive by default.
  Managed `bash` activates job controls when it leaves a running job. Goal, loop,
  monitor and schedule controls activate with their workflow and preserve tools
  the user excluded from the initial selection.

## Comparison after this pass

The practical gaps identified in checkpoint correctness, visible pagination,
foreground/side-chat streaming, explicit search access, useful research filters,
remote PDF reading, child persistence and queue-only messages are covered.
Local strengths remain persistent multi-chat workspaces, reviewed handoffs,
project-scoped history, narrow-terminal context visibility, bounded managed jobs,
and the portability/packaging checks.

The reference still has broader global rendering caches, image sidecars,
custom code-fence rendering, and more provider-specific research controls.
Those do not justify private host patches or expanding the catalog indiscriminately.
Our compact tool set and current-host compatibility are deliberate choices.
Freshness controls, evolving session titles and shell-change reconciliation can
be considered when a concrete workflow needs them. No provider expansion,
terminal-manager adapter, analytics collector or Linux sleep inhibitor is needed.

This establishes implemented workflow coverage. It does not establish that our
search relevance, latency or visual design wins every comparison: the reference
was source-reviewed, not run through a controlled side-by-side benchmark.

## Verification evidence

- Fresh isolated host: 39 extensions load with no errors/network requests;
  14 active tools, 14,091 description-and-schema bytes (previously 31 / 20,405).
- Combined real PTY captures at 100×34 and 60×28: compact plan receipt, active and
  settled editor/footer states, narrow workflow summary, searchable transcript,
  loop inspection and doctor. Zero extension errors or network attempts. Separate
  native fixtures cover web rows, long commands, error wrapping, partial shell
  output, side-chat streaming and telemetry restoration.
- Final macOS suite: **1,083 passed, zero failures** (native power assertion included).
  Final Linux ARM64 suite: **1,082 passed, one macOS-only skip, zero failures**. The macOS-only power-assertion test
  is opt-in and intentionally excluded from Linux; Linux sleep prevention is off.
- Clean macOS and Linux consumer installations validate the 210-file artifact,
  fresh dependencies, a real native PTY command, and both extension load orders.
  No publication, hosted CI run or Windows validation is implied.
- Live keyless Exa: an ax documentation query with inclusion/exclusion filters
  returned the primary site in 1.63 s; a fast Exa query with a start-only date
  bound returned two in-domain sources in 1.18 s. These are working samples,
  not a relevance benchmark or evidence that fast mode always returns the best source.
- Live keyless page/PDF reads: official Exa documentation (1.31 s) and a public
  arXiv paper URL (0.74 s) returned bounded 4,000-character excerpts. Both were
  labelled incomplete; no structured final-redirect metadata was available.
- A synthetic 50,000-entry history scan with roughly 12 MB of text took 425 ms
  for five sparse matches and 366 ms for an absent term on this Mac. No result
  cursor was invented at exhaustion. These are one-run local timings, not a
  cross-platform or reference-performance comparison.

Remaining verification limits: live account/paid requests, actual notification
and Telegram delivery, terminal hyperlink clicks, Windows, hosted CI, human
visual preference, and a controlled retrieval/performance comparison. Host API
limitations remain documented in [host-api-gaps](host-api-gaps.md); Ghostty remains
in the [later integration study](ghostty-integration.md).
