# cat-buddy

Adds an animated cat above Pi's input bar. Smart mode moves occasionally and reacts while Pi is working.

## Usage

```text
/cat                Open the control panel
/cat status         Show current settings
/cat smart          Animate adaptively (default)
/cat always         Animate continuously
/cat working        Animate only while Pi works
/cat static         Disable animation
/cat show|hide      Change visibility
Ctrl+Shift+C        Toggle visibility
```

The panel uses arrow keys or `j`/`k`, Enter, and Escape. The cat decorates the current editor, so it composes with `codex-prompt` and `history-search`.

Animation pauses while hidden or when the terminal is too small. Use static mode if animation disrupts terminal scrollback.

## Dependencies and limitations

- Uses Pi's extension, editor, and TUI APIs; no third-party packages.
- Interactive TUI only; cross-platform.
- Hidden below 34 columns or 10 rows.
