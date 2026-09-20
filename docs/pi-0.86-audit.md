# Pi 0.86 compatibility audit

Reviewed on 2026-09-20 against the published **0.86.1** npm packages, upgrading
this repository from 0.85.1. GitHub's latest release and npm's `latest` tag both
resolved to 0.86.1. The development dependencies are pinned to that release;
peer dependencies now require `>=0.86.1 <0.87.0`.

Sources: [0.86.1 release](https://github.com/earendil-works/pi/releases/tag/v0.86.1),
[0.86.0 release](https://github.com/earendil-works/pi/releases/tag/v0.86.0),
[tagged extension API](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/extensions.md),
[tagged session format](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/session-format.md).
The installed public declarations and implementation were compared with the
previous version, followed by TypeScript, extension tests and package loading.

## Release changes and decisions

- **Transcript-backed prompts and tools:** provider adapters now receive normalized
  `TranscriptContext`. The direct Codex adapter fixture now calls `normalizeContext`
  and uses an available model, GPT-5.5, because Codex GPT-5.4 was removed. Production
  extensions do not implement custom providers. Context attribution avoids counting
  persisted system messages a second time. Native tests cover prompt/tool records
  in child forks and prompt state across journal compaction and reload.
- **Configured auxiliary model calls:** session titles, side chats and child-context
  summaries now use `ctx.modelRegistry.streamSimple()`. Pi resolves authentication,
  headers, endpoints and custom provider dispatch. The old global compatibility
  completion path is removed from production code. Summary errors and aborts cannot
  become successful partial handoffs. Title calls omit optional reasoning instead
  of passing the invalid stream level `"off"`.
- **Cache warming:** the footer and usage export include standalone `usage` entries.
  Footer totals also invalidate when the branch leaf changes, covering idle warming
  without an assistant event. Exports retain usage category, provider and model.
  Turn statistics, separator blocks and goal token budgets continue to describe
  main-agent responses; background refresh requests are not assistant responses.
  Warming policy remains controlled by Pi's settings; this update does not enable
  extra paid requests or override `cache_warming_decision`.
- **Strict tool schemas:** tool-render already preserves native tool metadata by
  spreading the exported definitions. Managed Bash now explicitly retains Pi's
  `json_schema` / `strict: "prefer"` preference. Native integration verifies both
  extension load orders. Unsupported providers retain Pi's fallback behavior.
- **JSON-only tool arguments/details:** all production extensions typecheck with
  the tighter types; existing tool data is serializable. No migration to classes,
  mutable JSON arrays or non-JSON tool details is required.
- **Fail-closed `user_bash`:** no extension registers this hook. Managed Bash uses
  the model tool API; Pi's `!` command handling remains host-owned.
- **Discovery and clipboard:** session-search now passes its abort signal to native
  session discovery and uses Pi's public asynchronous clipboard API, gaining its
  native backends, WSL handling and OSC 52 fallback. Failure still uses the editor.
- **Other capabilities:** existing editor decorators preserve the host's embedded
  spinner methods. Session-long handlers do not need the new `pi.on()` unsubscribe
  return value. Workflow tool activation still uses `setActiveTools`; Fireworks'
  new provider-specific tool-search deferral does not replace that lifecycle.
  Per-model compaction settings and new Meta models remain host-managed.
- **Remaining API gaps:** no public custom code-fence renderer, grammar registry or
  transparent image-storage adapter was added. The designs in
  [host-api-gaps.md](host-api-gaps.md) remain deferred.

## Every extension

“Compatible” means no release-specific implementation change was needed after
reviewing the relevant contracts and running its existing tests on 0.86.1.

| Extension | Result and evidence |
|---|---|
| background-jobs | Updated managed Bash strict-schema preference; execution, streaming, PTY cleanup and both renderer load orders tested. |
| cat-buddy | Compatible; editor decoration retains native spinner space, animation and narrow-width tests pass. |
| code-blocks | Compatible; public Markdown transforms and language mapping unchanged; custom fence/grammar APIs remain unavailable. |
| codex-prompt | Compatible; preserves native editor methods and embedded status row; editor composition tests pass. |
| context | Updated attribution to exclude transcript system records already represented by prompt/schema sections; native estimator regression added. |
| context-journal | Compatible; native rollover test now also verifies system prompt state survives compaction and disk reload. Existing explicit journal budgets remain unchanged. |
| doctor | Updated supported-host diagnostics to 0.86.1–0.86.x; read-only configuration checks pass. |
| fast-mode | Production request hook compatible; direct adapter test migrated to normalized transcript input and an available Codex model. |
| file-changes | Compatible; tool events, mutation tracking, branch restore and UI tests pass. |
| footer | Updated standalone usage accounting and leaf-aware cache invalidation; idle warming totals tested. |
| goal | Compatible; custom context injection, persistent state, response budgets and deferred controls tested. |
| handoff | Compatible; public session replacement and selective checkpoint transfer tested; fresh destination uses its own native prompt state. |
| history-search | Compatible; prompt-only history ignores system messages; picker, keybinding and native integration tests pass. |
| hyperlinks | Compatible; public Markdown transforms and terminal capability handling unchanged. |
| image-history | Compatible; context transformation preserves unrelated system messages; native retrieval and reversible deferral tests pass. No storage-sidecar API added. |
| loop | Compatible; scheduling, context messages, settlement and deferred controls tested. |
| memory | Compatible; explicit storage/tool operations and schemas pass; no system-prompt replacement or automatic recall migration needed. |
| monitor | Compatible; command execution, cancellation, wakeups and deferred controls tested. |
| notify | Compatible; lifecycle and goal notifications tested; standalone cache usage does not produce agent-completion notifications. |
| overlay-stack | Compatible; layout, modal coordination and lifecycle cleanup tests pass. |
| plan | Compatible; custom context, persistence and branch-navigation tests pass. |
| prevent-sleep | Compatible; lifecycle and process cleanup tests pass; documented macOS-only behavior retained. |
| questions | Compatible; JSON tool results, secret handling, UI and Telegram races tested. |
| rewind | Compatible; native session fork API preserves host prompt history; prompt-only picker and cancellation tests pass. |
| schedule | Compatible; persisted schedules, cron/timezone logic, delivery and panels tested. |
| session-search | Updated native discovery cancellation and clipboard delegation; stale results and editor fallback tested. |
| session-title | Updated registry model calls and reasoning options; bounded requests, override fallback and configured-provider integration tested. |
| side-chat | Updated registry streaming; custom provider dispatch, incremental output, authentication cancellation and title lifecycle tested. |
| subagents | Updated registry summarization, error/abort handling and separate routing ID; fork test now includes transcript prompt/tool patches; RPC/continuity tests pass. |
| telegram | Compatible; service, shared inbox, routing, topic and cross-process fixture tests pass. |
| tool-render | Compatible; preserves native strict-schema metadata, execution and cwd binding; managed/standalone integration tested. |
| transcript | Compatible; user-facing history continues to omit internal prompt/tool-state and standalone usage records; model/search/native rendering tests pass. |
| turn-separator | Compatible; assistant-response timing/usage scope remains intact; native renderer tested. |
| turn-stats | Compatible; multi-response run accounting, settlement and disk persistence tested. Cache warming remains outside main-agent response totals. |
| usage-export | Updated standalone usage rows with category/provider/model attribution and deduplication; privacy allowlist and CSV tests pass. |
| verify | Compatible; successful edit/write hooks, trust checks and process execution tested. |
| web-search | Compatible; schemas/renderers and provider clients unchanged by this host release; deterministic provider and native reader/render tests pass. |
| working-status | Compatible; native indicator customization and decorated-editor rendering tested; host owns compaction/branch/retry spinner placement. |

## Validation

- `bun run check`: TypeScript passes; **1,143 tests pass, 1 optional native macOS
  sleep-assertion test skipped, 0 failures**, across 165 files. Local socket
  fixtures required execution outside the restricted sandbox.
- `bun run check:package`: archive contents and both native extension load orders pass.
- `bun run check:install`: a fresh consumer installation with Pi 0.86.1 executes a
  real native PTY command and loads/shuts down all 38 extensions in both orders.
- `bun run preview:ui`: native PTY checks pass at 100 and 60 columns, including
  active/settled state, overlay hide/show, transcript search, doctor and loop views;
  no extension errors or network requests.
- `git diff --check`: passes.

Tests use local synthetic providers; no live paid model calls or Telegram/Herdr
messages are sent. Platform coverage from prior audits remains historical; this
release is tested on the current macOS host. Linux was not rerun and Windows
remains unverified. The package now requires Pi 0.86.1 or a later 0.86 patch;
older hosts must upgrade before loading these changes.
