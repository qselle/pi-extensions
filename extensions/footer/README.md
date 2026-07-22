# footer

A single-line status bar in the Codex style, replacing pi's built-in footer.

```
global.anthropic.claude-opus-4-8 max · ~/private · Ready · Context 94% left · Context 6% used · 258K window · 28.2K used · 96K in · 521 out
```

Order matches Codex, left to right:

- **model + effort** — the model id with its reasoning level (`max`, `high`, `xhigh`, …)
- **directory** — home-relative working directory
- **status** — `Ready` when idle, `Working` while the agent runs
- **context** — `X% left`, `Y% used`, the model's window, tokens used, and
  cumulative input/output tokens for the branch
- **cost** — cumulative `$` when the provider reports it

## Behavior

- **No timers.** Renders on the TUI's normal cycle plus agent start/settle (so
  `Ready`/`Working` flips promptly). An idle session does no rendering work.
- **Compaction-safe.** Token/percent fields show `?` until the next response.
- **Responsive.** Fields drop from the tail on narrow terminals — `cost`, then
  `out`, `in`, `used`, `window`, `dir`, `status` — so the line never wraps. The
  model and `% left` figure survive longest.

Colors come from the active theme: `% left` and cost use `success`, the status
uses `accent`, and the rest stays `muted`.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`ctx.ui.setFooter`, `ctx.getContextUsage`, `ctx.isIdle`, `pi.getThinkingLevel`, `ctx.sessionManager`, `ctx.model`).
- **Depends on extensions:** None.
- **Used by extensions:** None.
