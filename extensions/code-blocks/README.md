# code-blocks

Makes named code blocks easier to read and restores syntax highlighting when a
fence contains a filename or other label after its language.

## Usage

Enabled when loaded. For example, an assistant fence headed
`typescript src/app.ts` displays a separate `src/app.ts` caption and uses Pi's
TypeScript highlighter. A filename-only fence such as `src/app.ts` uses Pi's
public filename-to-language mapping. Common aliases and mixed-case language names
are normalized (`TS` → `typescript`, `shell` → `bash`).

Code contents are preserved byte for byte. This is a display transformation;
stored messages, model context, copied raw messages and exported source are
unchanged. User messages and thinking text are untouched. Disable this extension
through Pi's extension configuration to return to the host presentation.

## Dependencies and limitations

- Pi 0.87.0 public Markdown transformer and language mapping APIs; `marked` is a
  declared runtime dependency, matching the parser version used by Pi's TUI.
- Handles top-level fenced blocks. Nested list/quote blocks, indented code, HTML
  literals, CRLF documents and unknown filename types are left as supplied.
- Streaming captions appear once the fence closes. Documents over 256,000
  characters bypass the extra parse. A cache keeps at most eight results and
  512,000 source/result characters combined. Native Markdown rendering still applies.
- Captions are bounded to 160 Unicode characters, rendered as literal inline code,
  and stripped of terminal controls. Code text itself is never reformatted.
- Retains Pi's native fence borders, wrapping and theme colors. The public hook
  does not provide a custom code-block renderer or grammar registration; adding
  an unsupported grammar such as Zig needs a host API extension.
