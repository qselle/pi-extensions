# code-blocks

Adds Shiki syntax colors to Gruvbox code blocks, with compact language/file
captions and highlighting that updates as code streams.

## Usage

Enabled when loaded. For example, an assistant fence headed
`typescript src/app.ts` displays a `typescript · src/app.ts` caption and Shiki's
Gruvbox colors. A filename-only fence such as `src/app.ts` uses Pi's
public filename-to-language mapping. Common aliases and mixed-case language names
are normalized (`TS` → `typescript`, `shell` → `bash`).

Code contents are preserved byte for byte beneath the display colors. Stored
messages, model context, `/copy` and exported source are unchanged. The same
formatting applies to code inside expanded thinking; user messages are untouched.
Selecting a theme other than `gruvbox-dark` keeps Pi's native theme-aware syntax
colors and filename captions. Disable this extension through Pi's extension
configuration to return to the host presentation.

## Dependencies and limitations

- Pi 0.87.0 public Markdown transformer and language mapping APIs; `marked` and
  `shiki` are declared runtime dependencies. Shiki 4 requires Node.js 20 or newer.
  Its bundled Oniguruma engine, grammars and theme run locally without a service
  or network request. One cached highlighter loads before the first render and
  is disposed when the extension shuts down or reloads.
- Shiki uses `gruvbox-dark-medium` foreground colors and font styles. It does not
  paint backgrounds. A truecolor terminal gives the intended palette.
- Loaded grammars: TypeScript/TSX, JavaScript/JSX, Bash, Python, JSON/JSONC, YAML,
  TOML, HTML, CSS/SCSS, SQL, Rust, Go, C/C++, Zig, Markdown, diff, Dockerfile,
  Makefile, Ruby, Java, Kotlin and Swift. No language is guessed from code content.
- Handles top-level fenced blocks. Nested list/quote blocks, indented code, HTML
  literals, CRLF documents and unknown filename types retain native rendering.
  Fences indented by one to three spaces retain native syntax colors as well.
- Syntax highlighting and captions appear as soon as a complete opening fence
  line arrives, including while code streams. Incomplete opening lines remain
  unchanged. Documents over 256,000 characters bypass the extra parse. A cache
  keeps at most eight results and 512,000 source/result characters combined.
- Unsupported grammars, source containing terminal controls, initialization
  failures, blocks over 64,000 characters, 2,000 lines or lines of 4,096 characters
  fall back to native highlighting. The syntax cache holds at most 32
  blocks and 512,000 source/output characters; unchanged blocks are reused.
- Captions are bounded to 160 Unicode characters, rendered as literal inline code,
  and stripped of terminal controls. Code text itself is never reformatted.
- Retains Pi's native fence borders and wrapping. For a slim code
  gutter, set `markdown.codeBlockIndent` to `"│ "` in Pi settings. This affects
  displayed lines only; raw code is unchanged. Highlighted display blocks use an
  empty language fence to avoid passing ANSI colors through a second grammar;
  the language remains visible in the caption. No host patch is installed.
