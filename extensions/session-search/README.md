# session-search

Full-text search across saved Pi sessions, with ranked results and safe navigation actions.
It is for finding a conversation when you remember something inside it but do not know
which session to resume.

```text
/session-search auth middleware
/session-search --current Type.Boolean
/session-search --all deployment timeout
```

Calling `/session-search` without a query opens an input prompt. Search is interactive and
model-free: the extension registers a slash command, not an LLM tool, and never injects
session history into model context.

## Scope

The default scope is every session returned by Pi's public `SessionManager.listAll()` API.
Use `--current` (or its `--project` alias) to restrict results to the current project:

```text
/session-search --current migration error
```

Within a Git checkout, current-project scope compares the nearest `.git` roots, so sessions
started in repository subdirectories are included while nested and sibling repositories are
excluded. If the current directory is not inside Git, scope requires the exact session working
directory. Missing historical subdirectories under the current Git root remain discoverable.

Use `--all` to switch back to all projects. Flags may appear before or between query words;
put `--` before a literal search term beginning with `--`.

## Search behavior

The extension searches locally stored:

- session titles, IDs, working directories, and first prompts
- user and assistant text
- tool-call names and arguments, tool-result text, and shell commands
- assistant errors
- compaction and branch summaries
- visible custom messages, labels, and model changes

Plain extension-state entries, image data, and model thinking are intentionally excluded to
reduce noise and avoid surfacing content that was not intended as recoverable conversation
text.

Matching is case-insensitive and requires every distinct query term to occur somewhere in a
session. Ranking favors exact phrases, complete per-entry matches, titles, user messages,
summaries, and then recent modification time. The displayed excerpt comes from the strongest
entry, preferring one that contains more query terms.

## Result actions

After selecting a ranked result, choose:

- **Resume this session** — switch to the original session through Pi's replacement-safe API.
- **Fork through the matching entry** — create a new persisted session through the exact
  matching entry, falling back to the source leaf for metadata-only matches.
- **Copy matching excerpt** — use a supported local clipboard command.
- **Put excerpt in editor** — place the bounded excerpt in Pi's editor for review or submission.

A cancelled fork switch removes the unused fork when possible. A successful resume/fork uses
only the fresh replacement context after the old runtime is torn down.

## Bounds and failure handling

Search is deliberately bounded:

| Limit | Value |
|---|---:|
| Concurrent file scans | 6 |
| Bytes scanned per session | 64 MiB |
| Maximum JSONL line | 1 MiB |
| Returned ranked results | 100 |
| Displayed excerpt | 360 characters |
| Query length | 300 characters / 32 distinct terms |

Malformed JSONL lines and oversized entries are skipped rather than failing the complete
search. Unreadable files and capped scans are counted in no-result diagnostics and displayed
on affected result details. Text shown in the picker is stripped of terminal controls and
Pi web-search metadata.

The byte limit applies per session. Searching a very large archive still reads every eligible
session up to that limit, so `--current` is preferable when project scope is known.

## Privacy and context behavior

Session search reads saved session files already available to the local Pi process. It has no
network access or telemetry. All-project search can display excerpts from unrelated projects,
which is why current-project scope is available.

Results remain in the UI. The model sees an excerpt only if you place it in the editor and
submit it, or if you resume/fork into a session where that history is part of the active
branch. The extension never registers a model tool and never modifies provider context.

## Comparison with adjacent features

| Feature | Best used when |
|---|---|
| Pi `/resume` | You already recognize the session to reopen |
| `history-search` | You want to reuse a prompt or shell command from the active branch |
| `session-search` | You remember text inside an unknown saved session |
| `memory` | You want the model to retrieve explicitly curated cross-session knowledge |

Session search does not distill or persist new knowledge. Memory does not scan raw historical
sessions. They are complementary.

## Clipboard support

Copy attempts fixed commands without invoking a shell:

- macOS: `pbcopy`
- Windows: `clip.exe`
- Linux/Wayland/X11: `wl-copy`, then `xclip`, then `xsel`
- Termux: `termux-clipboard-set`

If no command is installed or a copy fails, the excerpt is placed in the editor. Resume, fork,
and editor actions are OS-neutral.

## Dependencies and limitations

- **Runtime:** Pi's public extension and session APIs plus Node.js standard-library modules.
- **Third-party runtime packages:** None.
- **Mode:** Interactive TUI only; print, JSON, and RPC modes cannot display the picker.
- **Storage:** Read-only access to Pi session JSONL, except an explicit fork action creates a
  normal Pi session file and cancelled unused forks are cleaned up.
- **Search semantics:** Lexical rather than semantic; paraphrases with no shared terms do not
  match.

## Attribution

This extension is adapted from Angristan's MIT-licensed
[`session-search`](https://github.com/angristan/pi-extensions/tree/main/extensions/session-search).
It retains the command-first interaction model while adding Git-root project scope, stricter
streaming bounds, portable clipboard fallback, thinking exclusion, diagnostics, modularity,
and broader tests. The upstream copyright and license are included in
[`LICENSE.angristan`](LICENSE.angristan).
