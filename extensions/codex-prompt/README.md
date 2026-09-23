# codex-prompt

Replaces the editor's two-space gutter with a flat `›` prompt and keeps the input
area visible with accent-colored bars.

```text
────────────────────────
› Ask anything…
────────────────────────
```

## Usage

```text
/codex-prompt          Show status
/codex-prompt on|off   Save the setting; run /reload to apply it
/codex-prompt accent theme     Theme accent prompt and bars (default)
/codex-prompt accent thinking  Use Pi's thinking-level border colors
/codex-prompt accent #83a598   Use a fixed hex color; #abc also works
```

The default uses the theme's `accent` for `›` and `borderAccent` for its frame;
both are bright orange in Gruvbox. Thinking and fixed-hex choices color both together. Run `/reload` after
changing an accent. The extension wraps rendering and falls back to Pi's editor if the transform fails. Input handling and other editor decorators are preserved.

## Configuration

Settings are stored in `$PI_CODING_AGENT_DIR/codex-prompt.json` (normally `~/.pi/agent/codex-prompt.json`). For example: `{"enabled": true, "accent": "theme"}`. Set `enabled` to `false` to disable it manually. Commands preserve unrelated settings and refuse to overwrite malformed JSON; repair the file before saving changes.

## Dependencies and limitations

- Uses Pi's extension and editor APIs; no third-party packages.
- Interactive TUI only; cross-platform.
- Fixed hex colors use terminal truecolor escape sequences; use `theme` for the theme's color handling.
- Extremely narrow terminals render on a minimum internal canvas and clip to the available width, avoiding native wide-character wrapping failures.
