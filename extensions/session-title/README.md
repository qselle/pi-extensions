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
2. The active session model generates a specific two-to-four-word noun phrase with thinking disabled.
3. Once generation has been attempted, the extension does not retry or rename automatically. Existing and manually assigned titles always win; `/title now` remains an explicit override.

Automatic titling never blocks the main turn. While it is pending, the shared footer shows `[naming…]`; an explicit `/title now` on a named session shows `[renaming…]`. The badge disappears on success, failure, cancellation, or shutdown.

Manual names preserve your wording and punctuation (up to 120 characters),
flatten whitespace, and strip terminal controls. Setting a name through `/rename`
or `/title set` cancels any pending title request so a late model response cannot
replace it. Cancelling the name prompt leaves the current name unchanged.

The request sends only the triggering user request, uses a separate routing ID, and does not add anything to the main conversation or prompt cache. Failed, generic, or malformed results leave the session unnamed rather than showing a heuristic placeholder.

### Tab link for Herdr

Tab link reuses the Pi session name for the Herdr tab label, with no extra model
request. After `/reload`, run `/title tab link` once in the tab you want to link.
It immediately adopts the current Pi name, then follows generated titles,
`/rename`, `/title set`, and names set by other extensions.

Existing Herdr labels are preserved until you explicitly link them. The public
API exposes a displayed label without its origin, so even a number such as `1`
is treated as a possible manual name. An empty label can be linked automatically.
If you later rename or clear the label in Herdr, Tab link yields on its next
check; `/title tab link` explicitly reconnects it. `/title tab auto` resumes only
an empty or still-owned label.

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
{ "enabled": true, "model": "provider/model-id", "tabLink": true }
```

`model` is optional. When present, the extension tries that model first and safely falls back to the active session model when the override is missing, unauthenticated, or fails. Without an override, the active model is the portable default because it is already available and authenticated on the current machine.

The configuration is also used by [`side-chat`](../side-chat/) titles.

`tabLink` defaults to `true`, independently of automatic title generation's
`enabled` setting. Set it to `false` to disable automatic Herdr linking globally;
`/title tab link` or `/title tab auto` can enable it for the current session.
Side-chat titles do not rename Herdr tabs.

## Dependencies and limitations

- Uses Pi's extension, session-name, model, and lifecycle APIs plus `complete()` from `@earendil-works/pi-ai/compat`.
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
