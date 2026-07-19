# history-search

Native fuzzy reverse search for Pi's prompt history. Press `Ctrl+R`, type any subsequence, select a previous input, and place it back in the editor for review or resubmission.

The picker runs entirely inside Pi. It does not launch another terminal program or require runtime packages.

## Controls

| Key | Action |
|---|---|
| `Ctrl+R` | Open search; while open, move to the next match |
| `↑` / `Ctrl+P` | Previous match |
| `↓` / `Ctrl+N` | Next match |
| `PageUp` / `PageDown` | Move by one result page |
| `Enter` | Put the selected input in Pi's editor |
| `Escape` / `Ctrl+C` | Cancel and preserve the existing editor draft |

The same picker is available with `/history-search [initial query]`.

## Matching

Matching is case-insensitive and allows non-contiguous subsequences. Ranking favors, in order:

- exact matches
- prefixes and contiguous substrings
- consecutive characters
- word and path-segment boundaries
- shorter gaps and earlier matches
- newer entries when relevance is tied

Matched characters are highlighted. Empty queries show newest entries first.

## History scope

The extension uses Pi's public session API and searches every deduplicated entry available from:

- user prompts on the active session branch, including entries older than compaction
- `!` and `!!` commands represented on that branch
- interactive prompts observed during the current Pi process before they are persisted

It intentionally does not read private editor fields or scan other session files. Switching branches rebuilds search from the selected active branch. History and matching are not count-capped; the UI only paginates what is rendered on screen.

A short single-line editor draft seeds the initial query. Multiline or long drafts open an unfiltered picker. In either case, cancelling leaves the draft untouched; only confirming a result replaces it.

## `Ctrl+R` and session rename

Pi also uses `Ctrl+R` to rename a session *inside* the `/resume` session picker. This extension follows the contextual approach used by the upstream history-search extension: it intercepts `Ctrl+R` in a custom main editor instead of registering a global extension shortcut. As a result, history search wins in the normal editor, rename still wins inside `/resume`, and Pi does not report a shortcut conflict.

The editor wrapper preserves the border color of an editor installed before it (for example, `accent-color`) and restores that editor when the extension shuts down or reloads.

## Why the `fzf` executable is not used

An installed `fzf` binary is not needed. Launching it interactively would compete with Pi for terminal ownership, while invoking `fzf --filter` after every keystroke would add subprocess latency and lose the integrated editor, theme, draft-preservation, and overlay behavior. The native matcher provides the useful fuzzy-search behavior without an external dependency.

## Dependencies and limitations

- **Runtime:** Pi's public extension, session, editor, keybinding, and TUI APIs.
- **Third-party packages or executables:** None.
- **Mode:** Interactive TUI only; RPC, print, and JSON modes cannot display the picker.
- **Custom editors:** This extension installs its own `CustomEditor` wrapper. It preserves a predecessor's border-color behavior, but other custom input modes may depend on extension load order. `/history-search` remains available regardless.
