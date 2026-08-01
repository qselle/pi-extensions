# cat-buddy

A small animated cat that sits on Pi's input bar.

```text
  ⡠⡪⠕⢀⣀⢰⠑⠔⢱
  ⢇⡣⢴⠁⢄⠫⠬⡪⡬⠂
───⠈⠉⠒⠒⠓⠒⠚⠚──
```

Smart mode is enabled by default: the cat moves occasionally and reacts while Pi works. It hides on terminals that are too small and can be toggled without opening its panel.

## Commands

```text
/cat                Open the interactive control panel
/cat status         Show the current settings
/cat smart          Adaptive animation (default)
/cat always         Animate continuously
/cat working        Animate only while Pi works
/cat static         Stay still
/cat show|hide      Show or hide the cat
Ctrl+Shift+C         Toggle cat visibility
```

The panel supports arrow keys or `j`/`k`, Enter to select, and Escape to close.

The cat decorates the current editor through Pi's public editor API. Its first two rows sit above the editor and its feet replace the matching part of the top border, so it remains attached when the editor moves or grows. The cat uses the editor's accent color and the decorator preserves other custom-editor behavior, including `codex-prompt` and `history-search`.

Animated modes request renders and some terminals may jump back to the bottom. Use `/cat static` when stable scrollback is more important than animation. Hiding the cat—or making the terminal too small to display it—pauses its animation until it can be shown again.

## Dependencies and limitations

- **Runtime:** Pi's extension and TUI APIs.
- **Third-party packages:** None.
- **Compatibility:** The extension is terminal-independent and hides below 34 columns or 10 rows.
