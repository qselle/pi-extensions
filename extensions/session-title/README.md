# session-title

Names a session from its user prompts without changing a title you set manually.

## Usage

```text
/title             Show title state, model, usage, and the last error
/title now         Generate a new title now
/title set <text>  Set a title directly
```

1. The first meaningful request starts one bounded title request alongside the main agent request.
2. The active session model generates a specific two-to-four-word noun phrase with thinking disabled.
3. Once generation has been attempted, the extension does not retry or rename automatically. Existing and manually assigned titles always win; `/title now` remains an explicit override.

Automatic titling never blocks the main turn. While it is pending, the shared footer shows `[naming…]`; an explicit `/title now` on a named session shows `[renaming…]`. The badge disappears on success, failure, cancellation, or shutdown.

The request sends only the triggering user request, uses a separate routing ID, and does not add anything to the main conversation or prompt cache. Failed, generic, or malformed results leave the session unnamed rather than showing a heuristic placeholder.

## Configuration

Optional `$PI_CODING_AGENT_DIR/session-title.json`:

```json
{ "enabled": true, "model": "provider/model-id" }
```

`model` is optional. When present, the extension tries that model first and safely falls back to the active session model when the override is missing, unauthenticated, or fails. Without an override, the active model is the portable default because it is already available and authenticated on the current machine.

The configuration is also used by [`side-chat`](../side-chat/) titles.

## Dependencies and limitations

- Uses Pi's extension, session-name, model, and lifecycle APIs plus `complete()` from `@earendil-works/pi-ai/compat`.
- No third-party packages.
- Requires access to the active model provider; a configured override may use another provider.
- Cross-platform; title generation works outside the TUI.
