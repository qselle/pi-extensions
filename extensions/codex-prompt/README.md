# codex-prompt

A flat Codex-style `›` input prompt on pi's editor, keeping the editor's
orange `─` rules.

```
──────────────────────────────────
› Ask anything…
──────────────────────────────────
```

Subclasses pi's `CustomEditor` and overrides **only** `render`: the first content
line's 2-space gutter becomes a `›` prompt (in the editor's border color). The
editor's `─` rules are kept, so the line count and cursor stay correct and
`cat-buddy` can still find the editor. All input handling — keybindings, history,
autocomplete, paste, multiline — is inherited unchanged.

## Safety

- **Typing can never break.** `render` wraps the transform in try/catch and
  falls back to pi's default rendering on any error, so the worst case is
  cosmetic.
- **Reversible.** Set `~/.pi/agent/codex-prompt.json` to `{ "enabled": false }`
  or run `/codex-prompt off`, then `/reload`.

## Commands

- `/codex-prompt` — show whether it's on or off
- `/codex-prompt on` / `/codex-prompt off` — toggle (takes effect after `/reload`)

## Notes

- The editor's `─` rules are preserved, so `cat-buddy` still sits on the top
  border as usual.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API (`ctx.ui.setEditorComponent`, `CustomEditor`).
- **Depends on extensions:** None.
- **Used by extensions:** None.
