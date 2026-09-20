# Personal setup decisions

Updated 2026-09-20. Features earn a place through a useful workflow, clear ownership
and maintainable public APIs. An external catalog is not a specification for this
package. Historical research and comparison documents record decisions, not a
requirement to reproduce every capability.

## Extension boundaries

| Workflow | Ownership and decision |
|---|---|
| Editing and reading output | Keep editor, footer, tool presentation and optional decoration independently selectable; share terminal primitives under `lib/` |
| Session naming | Keep generated/manual names and Herdr Tab link together in `session-title`, with one source of truth for titles |
| Telegram | Keep session topics, notifications and question replies in `telegram`; one shared receiver serves local sessions |
| Plans and automation | Separate user-facing workflows, reuse the same inspection panel instead of separate rendering implementations |
| Research | One `web-search` extension owns Exa search and page reading; keyless access works by default |
| Reloading | Use the host's `/reload`; the unused cross-session broker was removed before committing the setup |
| Optional capabilities | Context/image retrieval, decoration, telemetry and scheduling remain selectable or opt-in; they do not expand the fresh model tool surface unnecessarily |

The package contains 38 extensions, with 14 active model tools in a fresh fully
loaded session. The README gives a smaller starting set. Ghostty pane control and
host-dependent renderer/storage changes remain deferred; Linux sleep prevention
remains excluded.

## Telegram session topics

- A session creates its topic lazily; resume reuses it, while a fork gets a separate
  destination. Mapping keys include the session, bot ID and recipient.
- Topic names can follow Pi or be pinned. Fixed-topic configuration stays fixed.
- Unsupported destinations can use a labelled General message. A required-topic
  policy refuses that fallback; network/API errors never silently reroute it.
- Unconfirmed creation survives reload and requires an explicit retry. A separate
  command starts a replacement topic without deleting the old one.
- Every question captures its destination. A later session/topic switch cannot
  redirect replies, validation hints or resolution cards.
- A bounded private inbox persists replies before acknowledging Telegram update
  IDs. Local processes coordinate one poll, with cancellation and stale-lease
  recovery. Separate machines should use separate bots.

Commands, setup and limitations are in the [Telegram README](../extensions/telegram/README.md).
No new model tool is needed for topic management.

## Verification

The final implementation passed 1,136 tests on both macOS and Linux ARM64, with
zero failures and one expected opt-in macOS power-assertion skip. Tests include
native Pi title/topic events, fork isolation, shutdown cleanup, exact reply/topic
correlation, concurrent readers and two separate processes sharing a fake Telegram
server. The shared receiver's cancellation and stale-lease paths are exercised.

Clean consumer installs on both platforms ran a real native PTY and loaded/shut
down all 38 extensions in both orders without network requests from extension
startup. Typechecking and package validation passed. No live Telegram messages
were sent during development; live service behavior and Windows remain unverified.

## Commit policy

Each feature or cohesive supporting change has a separate commit with a
single-line message. Three initial UI/foundation commits use the requested
2026-09-19 author and committer dates; the remaining commits use their actual
2026-09-20 timestamps. Commits remain local until explicitly pushed.
