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

Only rendering changes. Tool execution, parameters, and result details come from Pi's built-in definitions. The tools rebind to the active session directory after session changes.

Consecutive `read`, `grep`, `find`, and `ls` calls are grouped into one exploration block. Repeated reads of one file merge their ranges. Grouping is live-only and is not rebuilt after reload.

`Ctrl+O` expands output. File targets use the shared helpers from [`hyperlinks`](../hyperlinks/). Enabling that extension is optional; it adds `/hyperlinks` mode controls and `/open-path`. Every rendered line is width-bounded; rendering errors fall back to a plain line.

## Configuration

The setting is stored in `$PI_CODING_AGENT_DIR/tool-render.json` as `{"enabled": false}` when disabled.

## Dependencies and limitations

- Uses Pi's public extension, built-in tool-definition, syntax-highlighting, and rendering APIs.
- Imports the [`hyperlinks`](../hyperlinks/) helper module; no third-party packages.
- Interactive TUI only; cross-platform.
- Pi reports a one-time startup warning for each intentionally overridden built-in tool.
- Compact `read` output omits inline image previews.
