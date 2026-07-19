# cat-buddy

A small animated cat that sits on Pi's input bar without taking extra space or covering text.

```text
  ⡠⡪⠕⢀⣀⢰⠑⠔⢱
  ⢇⡣⢴⠁⢄⠫⠬⡪⡬⠂
───⠈⠉⠒⠒⠓⠒⠚⠚──
```

Smart mode is enabled by default: the cat moves occasionally and reacts while Pi works. It hides whenever it would overlap content.

## Commands

```text
/cat                Open the interactive control panel
/cat status         Show the current settings
/cat smart          Adaptive animation (default)
/cat always         Animate continuously
/cat working        Animate only while Pi works
/cat static         Stay still
/cat show|hide      Show or hide the cat
```

The panel supports arrow keys or `j`/`k`, Enter to select, and Escape to close.
