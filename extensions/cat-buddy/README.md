# cat-buddy

A small animated cat that sits just above Pi's input bar.

```text
  ⡠⡪⠕⢀⣀⢰⠑⠔⢱
  ⢇⡣⢴⠁⢄⠫⠬⡪⡬⠂
───⠈⠉⠒⠒⠓⠒⠚⠚──
```

Smart mode is enabled by default: the cat moves occasionally and reacts while Pi works. It hides whenever it would overlap content and can be toggled without opening its panel.

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

The cat is a right-aligned `aboveEditor` widget, using Pi's public extension API. Animated modes request renders and some terminals may jump back to the bottom. Use `/cat static` when stable scrollback is more important than animation.

## Dependencies and limitations

- **Runtime:** Pi's extension and TUI APIs.
- **Third-party packages:** None.
- **Compatibility:** The extension is terminal-independent and hides when the editor is narrower than the cat.
