# side-chat

Runs separate, persistent conversations in the background without adding their history to the main conversation.

## Usage

```text
/side <question>  Start a background chat
/side             Open the side-chat workspace
Ctrl+Shift+S      Open the workspace
```

List view: arrows select, Enter opens, `n` creates, `d d` deletes, and Escape closes.

Chat view: Enter sends, PageUp/PageDown scroll, Home/End jump, `Ctrl+O` promotes the latest answer, `Ctrl+R` retries a failure, and `Ctrl+X` stops generation.

Multiple chats can run at once. Each chat is pinned to the model active when it was created, uses low reasoning, and caps output at 4,096 tokens. Text streams into the open workspace while generating. Partial text is transient: only completed answers are saved or eligible for promotion. Stopping, retrying, or switching branches discards the partial answer and ignores late chunks.

Context and persistence:

- `snapshot` (default) includes a bounded, read-only snapshot of the main conversation.
- `none` includes project instructions but no main-conversation history.

Side chats have no tools and cannot modify files or continue the main task. Promoting an answer adds it to the main transcript and delivers it on the next main turn.

Chats are stored as non-context session entries and restored per branch after reload or tree navigation. Interrupted generations restore as idle. [`session-title`](../session-title/) can replace the provisional title after the first answer.

Stopping a generation immediately releases the chat for another question, even if the provider is slow to honor cancellation; late results are discarded. Switching branches or shutting down aborts pending title requests and closes the workspace. Old title responses cannot rename a restored chat or overwrite a title changed while the request was pending. Cancellation while credentials are resolving prevents a subsequent model request.

While a chat runs, [`overlay-stack`](../overlay-stack/) shows a card and the footer shows separate usage.

## Dependencies and limitations

- Uses Pi's public extension, session, model, and TUI APIs including Pi 0.86.1's authenticated `ctx.modelRegistry.streamSimple()`.
- Requires [`overlay-stack`](../overlay-stack/); optionally uses [`session-title`](../session-title/).
- No third-party runtime packages.
- Requires the configured model provider. Provider overrides, authentication refresh,
  headers and custom streaming implementations are resolved by Pi.
- Workspace controls require the interactive TUI.
