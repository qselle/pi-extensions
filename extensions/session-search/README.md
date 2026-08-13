# session-search

Searches text across saved Pi sessions and lets you resume, fork, copy, or reuse a matching excerpt.

## Usage

```text
/session-search <query>              Search all sessions
/session-search --current <query>    Search the current Git project
/session-search --project <query>    Alias for --current
/session-search --all <query>        Explicitly search all sessions
```

Without a query, the command opens an input prompt. Use `--` before a literal term that begins with `--`.

Current-project scope compares nearest Git roots, including sessions started in subdirectories while excluding nested repositories. Outside Git, it requires the exact working directory.

Search and actions:

Search covers session metadata, user and assistant text, tool calls and results, shell commands, errors, summaries, visible custom messages, and model changes. It excludes thinking, images, and plain extension-state entries.

Every distinct query term must match. Exact phrases, per-entry matches, titles, user messages, summaries, and recent sessions rank higher.

After selection, choose one action:

- resume the session
- fork through the matching entry
- copy the excerpt
- place the excerpt in the editor

Copy uses `pbcopy`, `clip.exe`, `wl-copy`, `xclip`, `xsel`, or `termux-clipboard-set`, depending on the platform. If copying fails, the excerpt is placed in the editor.

## Dependencies and limitations

| Limit | Value |
|---|---:|
| Concurrent scans | 6 |
| Bytes per session | 64 MiB |
| JSONL line size | 1 MiB |
| Returned results | 100 |
| Excerpt | 360 characters |
| Query | 300 characters / 32 terms |

Malformed and oversized entries are skipped and reported. Search is lexical, not semantic. It reads local session files and has no network access. Results enter model context only if you submit an excerpt or resume/fork the session.

- Uses Pi's public extension and session APIs plus Node.js standard-library modules.
- No third-party runtime packages.
- Interactive TUI only.
- Read-only except when an explicit fork action creates a Pi session file; cancelled unused forks are removed when possible.

- Adapted from Angristan's MIT-licensed [`session-search`](https://github.com/angristan/pi-extensions/tree/main/extensions/session-search); see [`LICENSE.angristan`](LICENSE.angristan).
