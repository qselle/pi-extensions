# Repository guidelines

- Keep each extension in `extensions/<name>/` with an `index.ts` entry point.
- Write focused, maintainable TypeScript and use Pi's public extension API.
- Add or update focused tests for behavior changes.
- Document commands, configuration, dependencies, and platform limitations in each extension's README.
- Put third-party runtime packages in `dependencies`; Pi-provided APIs are supplied by the host.
- Avoid OS-specific behavior unless the extension documents it explicitly.
- Do not commit dependencies, generated output, logs, secrets, or machine-local state.

## Model context

- Treat context as a shared budget: keep always-on schemas, descriptions, prompt snippets, and tool output concise and non-duplicative.
- Keep the cacheable prompt prefix stable within a session. System prompts, tool definitions and their order, and payload transforms must be deterministic; never inject timestamps, counters, or live state near the front. Put mutable goal, plan, and runtime state in append-only messages or tool results (see `lib/context-anchor.ts`).
- Keep tool activation additive: register up front, activate without removing or reordering active tools, and omit `promptSnippet`/`promptGuidelines` on deferred tools (see `lib/deferred-tools.ts`).
- Prefer append-only transcripts over rewriting history. Context hooks must be deterministic; treat removals, rewrites, and compaction as deliberate cache resets and test prefix stability when touching them.

## Rendering

- Before adding or changing a tool, match the interaction and visual language of comparable tools here: naming, schema metadata, collapsed/expanded rendering, colors, truncation, progress, empty and error states. Reuse `lib/tool-ui.ts` and the `Lines` cache.
- Settled transcript rows are immutable snapshots: never read `Date.now()` or live process state from a historical component's `render()`; capture data once and keep repeated renders byte-identical.
- Treat redraws as expensive in long sessions: use width-keyed caches and change-driven invalidation; avoid global timers, off-screen mutation, and full-transcript recomputation.
