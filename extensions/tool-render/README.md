# tool-render

Restyles pi's built-in tools into compact, Codex-style transcript blocks: a `•`
status bullet + bold verb + target on line 1, then the output or diff indented
under a dim `└` branch — instead of pi's default filled card. The command or path
is shown once (in the headline), never duplicated.

```
• Ran bun test
  └ 12 pass  0 fail

• Read src/auth.ts
  └ 42 lines

• Edited src/auth.ts
  └ 40   export function add(a, b) {
    41 - return a - b
    41 + return a + b
    42 }

• Explored
  ├ Read src/auth.ts
  ├ Read src/footer.ts
  └ Searched "verify("
```

- **Headline** (`• Verb target`) — a subtle status bullet (muted, red on error) +
  a bold verb + the target. For file tools (`read`/`write`/`edit`/`ls`) the
  target is a clickable OSC 8 hyperlink; `bash` shows the command (once).
- **Body** — detail indented under a dim `└` branch. `bash` shows a bounded tail
  of output; `edit`/`write` render a line-numbered, syntax-highlighted diff with
  `+`/`-` colored markers (no background wash); read-only tools (`read`, `ls`,
  `grep`, `find`) show a one-line count summary. `Ctrl+O` expands output/diffs.
- **Grouping** — consecutive exploration calls (`read`/`grep`/`find`/`ls`) collapse
  into one `• Explored` block (a `├`/`└` tree of what was read/searched), so a burst
  of reads doesn't flood the transcript. Any other tool or a new assistant message
  starts a fresh block.

## Safety

- **Execution is untouched.** Each tool spreads the exported
  `createXToolDefinition(cwd)`, so `execute`, `parameters`, and the result
  `details` shape are exactly pi's built-ins. Only rendering changes.
- **Width-safe.** Every line is hard-fitted to the viewport and each component
  catches its own render errors, so a display bug degrades to one plain line
  rather than crashing the TUI.
- **Reversible.** Set `~/.pi/agent/tool-render.json` to `{ "enabled": false }`
  (or run `/tool-render off`) and `/reload` to restore pi's built-in rendering.

## Commands

- `/tool-render` — show whether the override is on or off
- `/tool-render on` / `/tool-render off` — toggle (takes effect after `/reload`)

## Notes & limitations

- Overriding built-in tools makes pi print a one-time "tool overridden" warning
  per tool at startup. This is expected.
- `read` results are summarized to a line count; inline image previews are not
  rendered in this compact view (open the file to view it).
- Exploration grouping is live-only: after a reload, restored exploration calls
  render as individual standalone blocks (the grouping isn't rebuilt from the
  session).

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`registerTool` built-in override, `renderShell:"self"`, `highlightCode`, `createXToolDefinition`).
- **Depends on extensions:** None.
- **Used by extensions:** None.
