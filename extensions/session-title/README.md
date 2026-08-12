# session-title

Names a session from its user prompts without changing a title you set manually.

## Usage

```text
/title             Show title state, model, usage, and the last error
/title now         Generate a new title now
/title set <text>  Set a title directly
```

1. The first substantive prompt creates a local provisional title.
2. After the turn settles, one bounded model request replaces it.
3. Once the session has a title, the extension leaves it unchanged unless `/title now` is used.

The model request includes user text only, uses a separate routing ID, and prefers an available low-cost model before falling back to the session model. Titles are limited to five words and 48 characters. Generic or malformed results are ignored.

## Configuration

Optional `$PI_CODING_AGENT_DIR/session-title.json`:

```json
{ "enabled": true, "model": "provider/model-id" }
```

The configuration is also used by [`side-chat`](../side-chat/) titles.

## Dependencies and limitations

- Uses Pi's extension, session-name, model, and lifecycle APIs plus `complete()` from `@earendil-works/pi-ai/compat`.
- No third-party packages.
- Requires access to the selected model provider.
- Cross-platform; title generation works outside the TUI.
