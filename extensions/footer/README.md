# footer

A single-line status bar in the Codex style, replacing pi's built-in footer.

```
global.anthropic.claude-opus-4-8 max · ~/private (main) · Ready · Context 94% left · Context 6% used · 258K window · 28.2K used · 96K in · 521 out
agents ↑12k ↓850 R20k $0.0421 · verifying tests…
```

Order matches Codex, left to right:

- **model + effort** — the model id with its reasoning level (`max`, `high`, `xhigh`, …)
- **directory** — home-relative working directory, with the git branch in parentheses
- **status** — `Ready` when idle, `Working` while the agent runs
- **context** — `X% left`, `Y% used`, the model's window, tokens used, and
  cumulative input/output tokens for the branch
- **cost** — cumulative `$` when the provider reports it

A second line appears only when other extensions report status through
`ctx.ui.setStatus()`.

## Behavior

- **No timers.** Renders on the TUI's normal cycle plus agent start/settle (so
  `Ready`/`Working` flips promptly). An idle session does no rendering work.
- **Constant-time frames.** Branch totals are scanned once and cached, then
  invalidated on `message_end`, `session_compact`, and `session_tree`, so a
  keystroke never walks the session.
- **Complete spend.** Totals count assistant usage, tool-result usage (nested
  model calls from tools such as [`subagents`](../subagents/) and
  [`side-chat`](../side-chat/)), and the usage recorded on branch summaries and
  compactions — matching what pi's own footer accounts for.
- **Other extensions stay visible.** Replacing pi's footer would otherwise hide
  everything reported through `ctx.ui.setStatus()`, so statuses come from the
  `footerData` provider pi passes to the factory and render on their own line,
  sorted by key and flattened to one line. `subagents`, `side-chat`, `verify`,
  and `session-search` all rely on this.
- **Live git branch.** The branch also comes from `footerData`, and the footer
  re-renders on pi's branch-change notification instead of polling. The
  subscription is released when the footer is disposed.
- **Session-replacement safe.** The footer factory closes over the session
  context, so `session_shutdown` restores pi's built-in footer and drops the TUI
  reference. Nothing renders through a context that `/new`, `/resume`, `/fork`,
  or `/reload` has already invalidated.
- **Compaction-safe.** Token/percent fields show `?` until the next response.
- **Responsive.** Fields drop from the tail on narrow terminals — `cost`, then
  `out`, `in`, `used`, `window`, `dir`, `status` — so the line never wraps. The
  model and `% left` figure survive longest.

Colors come from the active theme: `% left` and cost use `success`, the status
uses `accent`, and the rest stays `muted`.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`ctx.ui.setFooter` with its `footerData` provider, `ctx.getContextUsage`, `ctx.isIdle`, `pi.getThinkingLevel`, `ctx.sessionManager`, `ctx.model`).
- **Depends on extensions:** None.
- **Used by extensions:** [`turn-separator`](../turn-separator/) reuses the cell layout helpers from `format.ts`.
- **Third-party packages:** None.
- **Platforms:** Cross-platform; the footer only renders in TUI mode.
