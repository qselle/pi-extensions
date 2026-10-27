# session-title

Names a session and keeps the name on its main goal, without changing a title you set manually.

## Usage

```text
/title             Show title state, focus, model, usage, and the last error
/title now         Retitle now and resume automatic updates
/title set <text>  Set a title directly
/rename <text>     Set a title directly, or omit text for a TUI prompt
/title tab         Show Tab link's last status
/title tab link    Link this Herdr tab to the current Pi name
/title tab auto    Enable conservative automatic linking
/title tab off     Stop syncing this session; keep the current tab label
```

1. The first meaningful request of an unnamed session starts a draft title from that request alone, alongside the main agent request.
2. After each finished turn, the title is refreshed from the requests since the last refresh, the final answer, and a running session focus. The focus and a one-sentence turn summary are saved as hidden session entries, so later titles track the session's main goal rather than its latest detail. They follow the branch across reloads, resumes, forks, and tree navigation, and stay out of model context.
3. The configured models (or the default model), then the active session model, generate a specific two-to-four-word noun phrase, with thinking disabled unless configured.
4. A manual name pauses automatic updates: `/rename`, `/title set`, or any name that differs from the last title this extension set, including one from another extension or after a restart. `/title now` retitles and resumes them.
5. A refresh is skipped when no message arrived since the last title. `/reload` retitles once if turns finished since then.
6. Child agent processes (`PI_SUBAGENT_CHILD=1`) never title automatically, so they make no title request; `/title now` still works there.

Automatic titling never blocks the main turn. While the first title is pending, the shared footer shows `[naming…]`; an explicit `/title now` on a named session shows `[renaming…]`; later automatic refreshes show nothing. The badge disappears on success, failure, cancellation, or shutdown.

Manual names preserve your wording and punctuation (up to 120 characters),
flatten whitespace, and strip terminal controls. Setting a name through `/rename`
or `/title set` cancels any pending title request so a late model response cannot
replace it. Cancelling the name prompt leaves the current name unchanged.

Title requests use a separate routing ID and add nothing to the main conversation or prompt cache. They receive bounded text only: user requests, the last assistant answer, the saved focus, and recent turn summaries, or a few earlier turns before any focus exists; never reasoning, tool calls, or tool output. Failed, generic, or malformed results leave the current name unchanged rather than showing a heuristic placeholder. Path-like results are rejected too: absolute, home-relative, `file://`, drive, and pasted-clipboard paths (`/tmp/x.png`, `~/Downloads/…`), or a single path token with a file extension (`src/index.ts`). Greetings and prompts that are only such a pasted path do not count as a meaningful request.

Sessions named before this behavior have no saved title, so their names count as manual until `/title now`.

### Tab link for Herdr

Tab link reuses the Pi session name for the Herdr tab label, with no extra model
request. After `/reload`, run `/title tab link` once in the tab you want to link.
It immediately adopts the current Pi name, then follows generated titles,
`/rename`, `/title set`, and names set by other extensions.

Existing Herdr labels are preserved until you explicitly link them, except for
an empty label, Herdr's default ordinal (for example, label `1` on tab `…:t1`),
or a label already equal to the current Pi name (for example, set by another
tool), which are linked automatically. A matching label is adopted without a
write, including after an earlier pause, and then follows later Pi names. Other numeric labels remain possible manual
names. If you later rename or clear the label in Herdr, Tab link yields on its
next check; `/title tab link` explicitly reconnects it. `/title tab auto` resumes
only a default, empty, or still-owned label.

Split tabs pause synchronization, including explicit linking, so separate Pi
panes cannot compete for their shared label. Every update resolves the current
tab from the pane identity instead of trusting the launch-time tab ID. Moving
into a named tab preserves the destination's label. Once back in a single-pane
tab, synchronization is checked on the next title change or agent turn.

Ownership and session-specific on/off choices survive reload through Pi's custom
session entries, outside model context. Ownership also passes to a new session
in the same running Pi instance. Resuming in a different terminal does not take
over its tab. The socket path is not stored in the session. Turning off or exiting
Pi keeps the last label; the footer continues to manage the terminal title
independently.

## Configuration

Optional `$PI_CODING_AGENT_DIR/session-title.json`:

```json
{ "enabled": true, "refresh": "turn", "models": ["mistral/mistral-medium-3.5", "openai/gpt-4.1-mini"], "tabLink": true }
```

`refresh` is `turn` (default) to retitle after each finished turn, or `once` to
keep only the first-request title: one attempt, no retry after a failure.

`models` is an ordered preference list of `provider/model-id` entries. Each is
tried in turn when unavailable, unauthenticated, failing, slower than 20 seconds,
or returning no usable title; the active session model is always the last fallback.
An entry can also be `{ "model": "provider/model-id", "thinkingLevel": "minimal" }`
(`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) for a reasoning
model; otherwise titles request no optional thinking. Reasoning models get a
larger output budget (512 tokens, or 2,048 with a thinking level) because some
think even when asked not to. Without `models`,
the single `model` key is still honored as a one-entry list; when both are
present, `models` wins. With neither, `mistral/mistral-medium-3.5` is tried
first when Pi has credentials for it, then the active session model.

When a title comes from a model after the first configured one, a warning such
as `Title model fallback: mistral/mistral-medium-3.5 unavailable; used
openai/gpt-4.1-mini.` appears when that fallback route first becomes active,
and again whenever the route changes. `/title` shows the model
order and the latest fallback.

The configuration is also used by [`side-chat`](../side-chat/) titles, which
currently receive the first preferred model (`model`), or the default model,
with the active-model fallback.

`tabLink` defaults to `true`, independently of automatic title generation's
`enabled` setting. Set it to `false` to disable automatic Herdr linking globally;
`/title tab link` or `/title tab auto` can enable it for the current session.
Side-chat titles do not rename Herdr tabs.

## Dependencies and limitations

- Uses Pi 1.0's extension, session-name, custom-entry, model, and lifecycle APIs including authenticated `ctx.modelRegistry.streamSimple()`.
- No third-party packages.
- Requires access to the active model provider; a configured override may use another provider.
- Cross-platform; title generation works outside the TUI.
- Tab link uses Node's local socket API on macOS/Linux and requires a Herdr TUI
  pane with `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`. It is inactive
  in headless/RPC sessions, child agents, and popups without a pane identity. A
  Linux VM needs its own reachable Herdr socket; a macOS socket path cannot be
  used across machines.
- Uses Herdr's public [`pane.get`, `tab.get`, and `tab.rename` protocol](https://herdr.dev/docs/socket-api/).
  Unsupported responses leave the tab alone. Requests have a 750 ms deadline
  and a 64 KiB response limit; automatic work never waits on the main agent turn.
  Failures stay quiet and are visible in `/title tab`; the next title event or
  agent turn retries, without a polling timer.
- Manual-rename protection checks the last owned label before writing. Herdr
  has no conditional `tab.rename`, so an external rename or split in the brief
  interval between inspection and the write can still race it. A command already
  accepted by Herdr cannot be undone by cancelling the socket request.
