# cat-buddy

A small animated cat that sits on Pi's input bar without taking extra space or covering text.

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

The cat is an editor-relative, non-capturing overlay and follows the input bar as it moves. Pi does not expose public transcript scroll state to extensions; animated modes request renders and some terminals may jump back to the bottom. Use `/cat static` when stable scrollback is more important than animation.

## Dependencies and limitations

- **Runtime:** Pi's extension and TUI APIs.
- **Third-party packages:** None.
- **Compatibility:** Editor-relative placement observes Pi's private overlay compositor and fails closed if that implementation changes. The extension is terminal-independent but requires overlay support and enough free space beside the editor.
