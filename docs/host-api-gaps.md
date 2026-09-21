# Public host API gaps

The repository requires public Pi extension APIs. Inspection of Pi 0.87.0's
extension declarations confirms a Markdown source transformer and custom-entry
renderers, but no documented native code-fence renderer, grammar registration or
transparent image-payload storage adapter. These proposals are design work, not
implemented or submitted upstream changes.

The released [extension API declarations](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts)
were checked again during the [0.87 release audit](pi-0.87-audit.md). The rendering registrations
still expose Markdown transformation and custom message/entry rendering rather
than the native fence and storage contracts described here. Upgrading blindly is
not evidence that these capabilities become available.

Pi 0.87 adds canonical model-context edits and per-model image resizing. Neither
provides transparent image-payload storage, lazy loading, or custom fence rendering.

## Code rendering and language support

Needed public contracts:

- Register a language highlighter by canonical language ID and filename patterns,
  returning styled text while preserving the source characters.
- Register a code-fence presentation hook receiving source, language, optional
  caption, theme, available columns and streaming completeness.
- Scope registration to the extension lifetime; dispose on reload and define
  deterministic behavior when multiple extensions register for the same target.
- Preserve native fallback for unknown languages, errors and oversized input.
  Keep raw copying/export/context independent from styled presentation.

Acceptance evidence would include real assistant Markdown with Zig, named fences,
streaming partial fences, nested fences and widths down to one column; correct
copy/export bytes; theme changes; extension reload; and a bounded large-document
benchmark. A source transformer that labels Zig as another language does not meet
this requirement.

## Transparent image payload storage

Needed public contracts:

- An asynchronous serialization/resolution boundary for image content parts,
  applying to user messages, assistant content and tool results consistently.
- Opaque versioned references with MIME type, content digest and integrity checks;
  explicit errors for missing/corrupted blobs, never silently missing images.
- Lazy resolution for rendering and model requests, with bounded caches and
  cancellation. Session inspection should not hydrate every image at startup.
- Atomic blob/session writes and owner-only permissions. Forks, branches, exports,
  compaction and session deletion need explicit reference ownership semantics.
- Portable export/import that includes required payloads and can recover inline
  image records when the adapter is unavailable. Garbage collection must trace all
  retained session branches before removing content-addressed data.

Acceptance evidence would compare reopened/forked/exported sessions byte-for-byte
at the image-content boundary, verify missing/corrupt blob behavior and interrupted
writes, and measure disk size, startup memory and image hydration. Current
image-history reduces repeated model input only; it cannot prove those storage
properties.

## Compatibility decision

On 2026-09-20 the user chose to keep compatibility with the current host.
Custom fence presentation, additional grammar registration and transparent image
sidecars/lazy payload loading are therefore deferred. They are not completion
requirements for the current improvement work and are not implemented capabilities.

Revisit these designs only when supported public APIs become available and the
user wants the features. Do not create a host fork or patch private classes to
implement them. No host checkout has been changed, and no upstream issue or
message has been sent. Existing extensions retain their documented partial behavior.
