# image-history

Image controls for long conversations: defer older model inputs, or keep small
native previews with deduplicated original files. Both modes are opt-in and
independent. Existing session entries are never migrated or rewritten.

## Usage

```text
/image-history on      Defer images from earlier user turns
/image-history off     Restore Pi's normal image-context behavior
/image-history status  Show mode and the last request's deferred-image count
/image-store on        Store new large originals once, with native previews
/image-store off       Keep new images embedded; resolve existing originals
/image-store status    Inspect mode and this branch's stored-image counts
/image-store list      List the last twelve stored image references
/image-store view <reference>  Open an original in a separate terminal view
/image-store export    Save a portable session with every original embedded
/image-store export /absolute/path/session.jsonl
/image-store gc        Preview unused originals, then confirm cleanup
/image-store gc /absolute/path/archived-sessions
```

The `history_image` tool retrieves an image using the exact reference in a placeholder. It is active only while this mode is enabled. The setting persists as a branch-local custom session entry and restores after reopening or navigation.

All images in the latest user message and subsequent tool results remain available. Earlier user/tool-result images are replaced only when the same image can be recovered from the current branch. Unknown or extension-generated images without a stored source are preserved. Retrieval returns the original image as tool content, making it available again during the current turn.

### Original storage

With `/image-store on`, newly finalized user/tool images of at least 64 KiB may
use a preview of at most 384×384 pixels and 32 KiB. An original is stored only
when the preview saves at least half its embedded size plus 1 KiB. Images larger
than 32 MiB, unsupported formats, failed resizes and failed writes stay embedded.
Pi's public image resizer handles PNG, JPEG, WebP and GIF previews.

The original bytes are stored by SHA-256 under
`$PI_CODING_AGENT_DIR/image-store/originals/`. The original file is committed and
verified before replacing a finalized image part. Duplicate original bytes share
one file. The session keeps a real image preview and a signed reference; native
image-count estimation stays intact and Pi renders its normal preview exactly
once. Requests receive the exact original bytes before Pi applies the selected
model's normal image resizing rules.

One context pipeline defers old images first, then loads only remaining original
images. `history_image` retrieves the original, including when new-image storage
has since been turned off. Forks on the same agent directory share originals.
Only signed references present on the active branch, including canonical content
edits, are resolved. Preview lookup also uses signed original identity, so visually
identical thumbnails cannot retrieve the wrong original. Arbitrary marker text
does not load files. Missing or corrupt originals leave a preview
with an explicit model-context limitation and one local warning.

Originals and the signing key use private owned directories/files, no-follow
reads, bounded sizes and verified hashes. Original caching is limited to 16 MiB
of encoded data; a separate 1 MiB preview cache avoids repeated resizing. Both
are cleared on session navigation/shutdown. Keep the signing key
with the original store; losing it prevents reference verification. Committed
originals are not automatically pruned. A missing key stops storage and retrieval
until restored; it is never silently replaced over committed originals.

`/image-store view` loads one original on demand into Pi's native image component.
Escape, Enter or `q` closes the view. The image fits the available terminal rows;
this is a full-quality source rendered to terminal size, not a pixel zoom editor.
JPEG/WebP/GIF originals are converted through Pi's public PNG converter for Kitty
display; their stored/provider/export bytes stay unchanged. Terminals without
image support display Pi's image fallback. Native transcript
previews remain small for both current and resumed history.

### Storage cleanup

`/image-store status` (or `stats`) shows branch counts plus the store's total file
count, size and location. `/image-store gc` scans every branch in the default
session directory and all custom session directories recorded by this extension.
Exact active session paths are recorded too. Every regular file in these roots
is inspected for Pi's JSON-line records regardless of its filename extension;
renamed sessions and copies remain protected. Unrelated non-JSON files are ignored.
An optional directory adds archived or copied sessions to that persistent scan
list. References inside context edits and inactive branches also protect files.

The command previews eligible file count and size before asking for terminal
confirmation. It scans again under the shared writer lease after confirmation
and deletes only files from the approved preview that remain unused. New or
reused originals are protected for 48 hours, including the interval before a
session writes its reference. RPC/non-terminal use is preview-only.

Missing/unreadable custom directories, symlinks, malformed/oversized sessions,
changed files and cancellation stop cleanup. Restore unavailable directories
before retrying. Sessions copied outside the known directories cannot be
discovered automatically: include their directory before confirming cleanup, or
make them portable with export. No background cleanup runs.

### Sharing sessions

Pi's built-in exports contain the embedded preview. Use `/image-store export`
for full originals: it writes a new portable JSONL preserving the complete
session graph and embedding every stored original, including content-edit
replacements. The default destination is
`$PI_CODING_AGENT_DIR/exports/`; an explicit path is resolved against the current
working directory. Existing files are never overwritten. Missing/corrupt images
or cancellation fail the export without publishing a partial session.

A portable export can be copied independently of the store and opened in Pi.
Copying a reference-bearing session alone retains its previews but cannot supply
the original detail. Export does not alter the live session or its branch.

## Dependencies and limitations

- Uses Pi's public message/context, session, image resize, tool and status APIs;
  Node built-ins and the repository's existing `proper-lockfile` dependency for
  coordinating writers with cleanup. No package was added. Deferral
  is cross-platform. Original storage requires POSIX file ownership (macOS/Linux)
  and a local filesystem with atomic hard links.
- Inventory stops above 100,000 paths, directory depth 64, a 256 MiB session file
  or a 64 MiB entry. Unusually large sessions must be exported/archived before
  cleanup; files are retained when a complete scan is not possible.
- Disabled by default. Deferral changes what the model can immediately see; it must retrieve an older image when visual details matter. Text context remains unchanged.
- Pi 0.87's per-model `inputLimits.images.resize` controls apply when image input
  is sent, including retrieved tool images. Resizing controls image dimensions;
  this extension separately defers older images and retrieves them on demand.
  Canonical context omissions remain omitted when deferral is turned off.
- Deferral reduces repeated model input. Storage reduces new session payloads
  and native preview data; it does not shrink existing session files. Provider
  requests still require original bytes in memory, subject to the bounded cache.
- Original session messages are never rewritten. Turning the mode off restores normal context behavior for images still in Pi's active context; it does not undo native compaction.
- References are valid only on a branch containing the source entry. Retrieval cannot recover deleted session data or access another session's images.
- The displayed count describes transformed image parts in the last context pass, not provider token savings. Actual image accounting depends on the selected model.

### Reproducing the storage measurement

`bun extensions/image-history/storage.benchmark.ts` compares twenty repeated valid
PNG tool results in native saved sessions, including reopen, Kitty/iTerm2/fallback
rendering, repaint and resize. It uses temporary files and no network. Output
includes source/preview byte counts and timings; these exclude terminal I/O,
model latency and retained-memory measurement. The native integration fixture
separately verifies exact-original provider input and single-image rendering.
