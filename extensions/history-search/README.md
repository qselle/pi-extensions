# history-search

Fuzzy reverse search for prompts and shell commands on the active session branch.

## Usage

| Key | Action |
|---|---|
| `Ctrl+R` | Open search or move to the next match |
| `Up` / `Ctrl+P` | Previous match |
| `Down` / `Ctrl+N` | Next match |
| `PageUp` / `PageDown` | Move one page |
| `Enter` | Put the match in the editor |
| `Escape` / `Ctrl+C` | Cancel without changing the draft |

Use `/history-search [query]` to open it from a command. Selection and navigation follow Pi's configured `tui.select.*` bindings.

Matching is case-insensitive and supports non-contiguous subsequences. Exact, prefix, contiguous, and boundary matches rank ahead of wider gaps; recency breaks ties.

The search covers user prompts and shell commands on the active branch, including entries before compaction, plus prompts observed by the current process. It does not scan other session files. `Ctrl+R` is intercepted only in the main editor, so Pi's rename shortcut still works in `/resume`.

## Dependencies and limitations

- Uses Pi's public session, editor, keybinding, and TUI APIs.
- No third-party packages or executables; `fzf` is not required.
- Interactive TUI only; cross-platform.
