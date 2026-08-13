# footer

Replaces Pi's footer with one line for model, effort, directory, Git branch, run state, context usage, cumulative tokens, and cost.

```text
claude-opus max · ~/project (main) · Ready · Context 94% left · 258K window · 28.2K used · 96K in · 521 out · $0.21
```

Statuses from other extensions appear on a second line only when present.

## Usage

- Usage is scanned once and cached until a message, compaction, or branch change invalidates it.
- Totals include assistant responses, tool-result model calls, summaries, and compactions.
- Context fields show `?` after compaction until Pi reports a new total.
- Narrow terminals drop lower-priority fields before allowing the line to wrap.
- Pi's original footer is restored when the extension shuts down.

There are no commands or configuration files.

## Dependencies and limitations

- Uses Pi's public footer, context, model, session, and lifecycle APIs.
- No third-party packages.
- [`turn-separator`](../turn-separator/) imports the shared formatting helpers.
- Interactive TUI only; cross-platform.
