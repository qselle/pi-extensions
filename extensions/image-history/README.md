# image-history

Opt-in image deferral for long conversations. Older images become retrievable references in model context while the original transcript remains intact.

## Usage

```text
/image-history on      Defer images from earlier user turns
/image-history off     Restore Pi's normal image-context behavior
/image-history status  Show mode and the last request's deferred-image count
```

The `history_image` tool retrieves an image using the exact reference in a placeholder. It is active only while this mode is enabled. The setting persists as a branch-local custom session entry and restores after reopening or navigation.

All images in the latest user message and subsequent tool results remain available. Earlier user/tool-result images are replaced only when the same image can be recovered from the current branch. Unknown or extension-generated images without a stored source are preserved. Retrieval returns the original image as tool content, making it available again during the current turn.

## Dependencies and limitations

- Uses Pi's public context, session, tool and status APIs; no third-party dependencies or external services. Cross-platform.
- Disabled by default. Deferral changes what the model can immediately see; it must retrieve an older image when visual details matter. Text context remains unchanged.
- This reduces repeated image input in subsequent requests. It does not shrink session files, remove base64 data from memory, or implement on-disk image sidecars. The installed public storage API has no transparent image-sidecar hook.
- Original session messages are never rewritten. Turning the mode off restores normal context behavior for images still in Pi's active context; it does not undo native compaction.
- References are valid only on a branch containing the source entry. Retrieval cannot recover deleted session data or access another session's images.
- The displayed count describes transformed image parts in the last context pass, not provider token savings. Actual image accounting depends on the selected model.
- Native runtime tests verify activation, reversible context changes, retrieval and unchanged original history. The fixture does not call a vision provider.
