# command-palette

Search the commands provided by your loaded extensions, prompt templates and skills in one keyboard-driven palette. Each result includes its description, resource kind and user/project/temporary scope.

## Usage

```text
/palette               Browse available commands
/palette telegram      Search names and descriptions
/palette project skill Filter by resource kind and scope
/palette restore       Recover the draft replaced by your last selection
Ctrl+Shift+P            Open the palette
```

Type to filter, use arrows or Page Up/Down to select, and press Enter to insert the command into the editor. Add any arguments and press Enter again to run it. Escape cancels and preserves your draft. Standard Pi select keybindings are respected.

Names rank above description matches; abbreviated names use fuzzy matching. Search terms can appear in any order. Commands are discovered again whenever the palette opens, so disabled plugins do not leave stale entries. Workflow cards hide while the palette is open.

The palette does not execute commands, call the model or add tools to its prompt. Replaced drafts stay only in memory and can be restored until the session changes, reloads or exits.

## Dependencies and limitations

- Requires Pi 0.87.x and its public command-discovery, shortcut, editor and custom-UI APIs. No additional runtime packages.
- Uses the history-search extension's pure fuzzy matcher; that extension need not be enabled.
- Interactive TUI only; cross-platform. Some terminals cannot distinguish Ctrl+Shift+P; `/palette` always works.
- Pi's command-discovery API excludes native commands such as `/model` and `/settings`; use Pi's slash completion for those.
- Results display resource kind and scope, not filesystem paths. No settings or session files are written.
