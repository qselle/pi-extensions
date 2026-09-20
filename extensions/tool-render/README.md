# tool-render

Replaces Pi's built-in tool cards with compact headlines, bounded output, grouped exploration calls, and line-numbered diffs.

```text
• Ran bun test
  └ 12 pass  0 fail

• Edited src/auth.ts (+1 -1)
   40   export function add(a, b) {
   41 - return a - b
   41 + return a + b
```

## Usage

```text
/tool-render          Show status
/tool-render on|off   Save the setting; run /reload to apply it
```

This extension changes rendering. Normally execution, parameters, and result details come from Pi's built-in definitions. If `background-jobs` is enabled, bash uses its managed executor and keeps these compact cards. The extensions negotiate through Pi's public event bus in either load order; the job ID and status remain visible when output is collapsed. The tools use the active session directory after session changes.

Shell commands use your theme's Bash syntax colors for keywords, built-ins,
strings, variables and comments. Highlighting applies to both inline commands
and wrapped command blocks, while running and after completion. Command text,
execution and output are unchanged. Reload Pi once to apply an extension update.

Consecutive `read`, `grep`, `find`, and `ls` calls are grouped into one exploration block. Repeated reads of one file merge their ranges. Grouping is live-only and is not rebuilt after reload.

Expanded exploration calls show their individual output, including calls hidden behind a grouped leader when collapsed. Output keeps the last 200 lines with an omitted-line count. Collapsed groups retain a failure diagnostic instead of replacing it with a successful read range. Command and edit/write errors show up to eight lines when collapsed and 200 when expanded.

`Ctrl+O` expands output. File targets use the shared helpers from [`hyperlinks`](../hyperlinks/). Enabling that extension is optional; it adds `/hyperlinks` mode controls and `/open-path`. Every rendered line is width-bounded; rendering errors fall back to a plain line.

Long physical lines are clipped to terminal width in both modes. These cards are a bounded preview; use the transcript or the tool's source/output artifact when you need the complete content for copying.

## Configuration

The setting is stored in `$PI_CODING_AGENT_DIR/tool-render.json` as `{"enabled": false}` when disabled.

## Dependencies and limitations

- Long or multiline shell commands wrap into a bounded command block; expansion
  reveals additional lines. Foreground managed commands stream output while
  waiting. Failed exploration calls remain visible even when successful calls are
  grouped, and bounded error text wraps so the actionable cause is readable.

- Uses Pi's public extension, built-in tool-definition, syntax-highlighting, and rendering APIs.
- Shell highlighting uses Pi's Bash grammar; embedded Python, JavaScript and other
  heredoc bodies are not separately parsed. Commands over 16,000 characters and
  highlighting failures use plain text, retaining the normal preview limits.
- Imports the [`hyperlinks`](../hyperlinks/) helper module; no third-party packages.
- Interactive TUI only; cross-platform.
- Pi reports a one-time startup warning for each intentionally overridden built-in tool.
- Compact `read` output omits inline image previews.

The combined package is checked through Pi's real resource loader in both load
orders. Managed jobs is the sole `bash` owner when present; tool rendering supplies
its style without registering a second executor. Standalone tool-render registers
its `bash` override at session start, after executor owners have loaded.
