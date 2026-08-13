# codex-prompt

Replaces the editor's two-space gutter with a flat `›` prompt while preserving its borders and input behavior.

```text
────────────────────────
› Ask anything…
────────────────────────
```

## Usage

```text
/codex-prompt          Show status
/codex-prompt on|off   Save the setting; run /reload to apply it
```

Only rendering is wrapped. Keybindings, history, autocomplete, paste, multiline input, and other editor decorators remain unchanged. Rendering falls back to Pi's editor if the transform fails.

## Configuration

The setting is stored in `$PI_CODING_AGENT_DIR/codex-prompt.json` (normally `~/.pi/agent/codex-prompt.json`). Set `{"enabled": false}` to disable it manually.

## Dependencies and limitations

- Uses Pi's extension and editor APIs; no third-party packages.
- Interactive TUI only; cross-platform.
