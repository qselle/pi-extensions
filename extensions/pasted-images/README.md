# pasted-images

OpenCode-style pasted images: a pasted screenshot or image file becomes an
`[Image N]` token with a thumbnail above the editor, is attached to the prompt
when sent, and stays as a thumbnail row in the transcript. Click a thumbnail
or press `Alt+I` for a full-screen viewer.

## Usage

```text
Paste an image or image path   Insert [Image N] and show its thumbnail
Backspace / Delete on a token  Remove the whole [Image N] and its image
Alt+I or /images               Open the viewer at the latest pasted image
Click a thumbnail              Open the viewer at that image (fullscreen mode)
←/→ (h/l)                      Previous / next image in the viewer
Esc, q or Enter                Close the viewer
```

A paste is converted only when it consists entirely of existing image file
paths (PNG, JPEG, GIF or WebP, up to 32 MiB): Herdr's clipboard images, files
dropped onto the terminal (quoted, backslash-escaped or `file://`), and the
temporary file Pi's own `Ctrl+V` writes. Other pastes, and pastes in bash mode
(`!`), are untouched.

As in OpenCode, a token is one highlighted block (bold on the theme's
warning color) and one unit in the editor: one `Backspace`, `Delete`
or word deletion removes all of it, the arrow keys step over it, and one undo
restores it with its image. On submit, each referenced image is attached
in label order and the tokens stay in the text, so the model can tell
`[Image 1]` from `[Image 2]`. Pi then applies its usual image resizing. Tokens
recalled from prompt history are plain text; paste the image again.

Originals are copied to `$PI_CODING_AGENT_DIR/pasted-images/` (owner-only,
named by SHA-256) so transcript thumbnails and the viewer keep working after
temporary clipboard files disappear. Nothing removes them automatically.

## Configuration

Previews are configurable like OpenCode's `prompt.image_preview` and
`session.image_preview`. Changes apply immediately and are saved to
`$PI_CODING_AGENT_DIR/pasted-images.json`:

```text
/images prompt on|off          Thumbnails above the editor (default on)
/images transcript on|off      Thumbnails under sent prompts (default on)
/images rows auto|2-16         Thumbnail height in rows (default auto)
/images color <name|#rrggbb>   Token block color (default warning)
/images settings               Show the current settings
```

```json
{ "promptPreview": true, "transcriptPreview": true, "previewRows": "auto", "tokenColor": "warning" }
```

`auto` uses OpenCode's sizing: a quarter of the terminal height, 4 to 8 rows.
Like OpenCode, the token block uses the theme's warning color with the
terminal background as text. Themes disagree on that color: OpenCode's
Gruvbox warning is orange, Pi Gruvbox themes often use yellow. Set a Pi theme
color name or a hex value, such as `/images color #fe8019`, to match.
With a preview off, tokens, attachments and the viewer still work; OpenCode
defaults both previews to off. Commands keep unrelated keys and refuse to
overwrite malformed JSON; invalid values fall back to the defaults.

## Dependencies and limitations

- Pi 1.0.4 public terminal-input, widget, input, entry-renderer, Markdown and
  image APIs, with Pi's image resizer; no runtime packages.
- Token blocks extend the editor's internal segmentation, the mechanism Pi
  uses for its own `[paste #N]` markers, and its rendered lines, on whichever
  editor has focus,
  including replacements from other extensions. If a Pi release removes it,
  tokens become plain text and still attach their images; the tests cover it.
  Word wrap may break a line just before a token rather than at the space.
- Thumbnails and the viewer need terminal image support. Herdr renders Kitty
  graphics but Pi does not detect it: set `PI_IMAGE_PROTOCOL=kitty` or
  `terminal.images: "kitty"`. Without image support, tokens still work and
  thumbnails show as labels.
- Each thumbnail row is composited into one PNG so Pi's Kitty image caching,
  cropping and scrolling apply unchanged. A row that does not fit the terminal
  width is followed by a `+N more` line; the viewer shows every image.
  Thumbnails have no captions, as in OpenCode: they follow token order.
- Clicking needs fullscreen mode, the default. The viewer fits images to the
  terminal, enlarging small ones; it does not zoom past the screen.
- When Pi's own `Ctrl+V` path is converted, the editor cursor moves to the end.
- Other extensions that handle prompt images, such as an image sidecar store,
  still run after this one and may show their own previews.
