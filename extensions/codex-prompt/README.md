# codex-prompt

Replaces the editor's two-space gutter with a flat `›` prompt and gives the prompt and borders a consistent theme accent.

```text
────────────────────────
› Ask anything…
────────────────────────
```

## Usage

```text
/codex-prompt          Show status
/codex-prompt on|off   Save the setting; run /reload to apply it
/codex-prompt accent theme     Use the current theme's accent (default)
/codex-prompt accent thinking  Use Pi's thinking-level border colors
/codex-prompt accent #83a598   Use a fixed hex color; #abc also works
```

Run `/reload` after changing an accent. Only rendering is wrapped. Keybindings, history, autocomplete, paste, multiline input, and other editor decorators remain unchanged. Rendering falls back to Pi's editor if the transform fails. Theme changes are reflected at render time, and Pi's underlying border color is preserved.

## Configuration

Settings are stored in `$PI_CODING_AGENT_DIR/codex-prompt.json` (normally `~/.pi/agent/codex-prompt.json`). For example: `{"enabled": true, "accent": "theme"}`. Set `enabled` to `false` to disable it manually. Commands preserve unrelated settings and refuse to overwrite malformed JSON; repair the file before saving changes.

## Dependencies and limitations

- Uses Pi's extension and editor APIs; no third-party packages.
- Interactive TUI only; cross-platform.
- Fixed hex colors use terminal truecolor escape sequences; use `theme` for the theme's color handling.
- Extremely narrow terminals render on a minimum internal canvas and clip to the available width, avoiding native wide-character wrapping failures.
