# session-title

Names a session from its user prompts without changing a title you set manually.

## Usage

```text
/title             Show title state, model, usage, and the last error
/title now         Generate a new title now
/title set <text>  Set a title directly
/rename <text>     Set a title directly, or omit text for a TUI prompt
/title tab         Show Tab link's last status
/title tab link    Link this Herdr tab to the current Pi name
/title tab auto    Enable conservative automatic linking
/title tab off     Stop syncing this session; keep the current tab label
```

1. The first meaningful request starts one bounded title request alongside the main agent request.
2. The configured models, then the active session model, generate a specific two-to-four-word noun phrase with thinking disabled.
3. Once generation has been attempted, the extension does not retry or rename automatically. Existing and manually assigned titles always win; `/title now` remains an explicit override.
4. Child agent processes (`PI_SUBAGENT_CHILD=1`) never title automatically, so they make no title request; `/title now` still works there.

Automatic titling never blocks the main turn. While it is pending, the shared footer shows `[naming…]`; an explicit `/title now` on a named session shows `[renaming…]`. The badge disappears on success, failure, cancellation, or shutdown.

Manual names preserve your wording and punctuation (up to 120 characters),
flatten whitespace, and strip terminal controls. Setting a name through `/rename`
or `/title set` cancels any pending title request so a late model response cannot
replace it. Cancelling the name prompt leaves the current name unchanged.

The request sends only the triggering user request, uses a separate routing ID, and does not add anything to the main conversation or prompt cache. Failed, generic, or malformed results leave the session unnamed rather than showing a heuristic placeholder. Path-like results are rejected too: absolute, home-relative, `file://`, drive, and pasted-clipboard paths (`/tmp/x.png`, `~/Downloads/…`), or a single path token with a file extension (`src/index.ts`). A prompt that is only such a pasted path does not count as the first meaningful request.

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
{ "enabled": true, "models": ["mistral/mistral-medium-3.5", "openai/gpt-4.1-mini"], "tabLink": true }
```

`models` is an ordered preference list of `provider/model-id` entries. Each is
tried in turn when unavailable, unauthenticated, failing, or returning no usable
title; the active session model is always the last fallback. Without `models`,
the single `model` key is still honored as a one-entry list; when both are
present, `models` wins. With neither, the active session model is used.

When a title comes from a model after the first configured one, a warning such
as `Title model fallback: mistral/mistral-medium-3.5 unavailable; used
openai/gpt-4.1-mini.` appears once per Pi runtime. `/title` shows the model
order and the latest fallback.

The configuration is also used by [`side-chat`](../side-chat/) titles, which
currently receive the first preferred model (`model`) with the active-model
fallback.

`tabLink` defaults to `true`, independently of automatic title generation's
`enabled` setting. Set it to `false` to disable automatic Herdr linking globally;
`/title tab link` or `/title tab auto` can enable it for the current session.
Side-chat titles do not rename Herdr tabs.

## Dependencies and limitations

- Uses Pi 1.0's extension, session-name, model, and lifecycle APIs including authenticated `ctx.modelRegistry.streamSimple()`.
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
