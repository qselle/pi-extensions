# pasted-images

OpenCode-style pasted images: a pasted screenshot or image file becomes an
`[Image N]` token with a thumbnail above the editor, is attached to the prompt
when sent, and stays as a thumbnail row in the transcript. Click a thumbnail
or press `Alt+I` for a full-screen viewer.

## Usage

```text
Paste an image or image path   Insert [Image N] and show its thumbnail
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

Delete a token to drop its image. On submit, each referenced image is attached
in label order and the tokens stay in the text, so the model can tell
`[Image 1]` from `[Image 2]`. Pi then applies its usual image resizing. Tokens
recalled from prompt history are plain text; paste the image again.

Originals are copied to `$PI_CODING_AGENT_DIR/pasted-images/` (owner-only,
named by SHA-256) so transcript thumbnails and the viewer keep working after
temporary clipboard files disappear. Nothing removes them automatically.

## Dependencies and limitations

- Pi 1.0.4 public terminal-input, widget, input, entry-renderer, Markdown and
  image APIs, with Pi's image resizer; no runtime packages.
- Thumbnails and the viewer need terminal image support. Herdr renders Kitty
  graphics but Pi does not detect it: set `PI_IMAGE_PROTOCOL=kitty` or
  `terminal.images: "kitty"`. Without image support, tokens still work and
  thumbnails show as labels.
- Each thumbnail row is composited into one PNG so Pi's Kitty image caching,
  cropping and scrolling apply unchanged. A row that does not fit the terminal
  width ends with `+N`; the viewer shows every image.
- Clicking needs fullscreen mode, the default. The viewer fits images to the
  terminal, enlarging small ones; it does not zoom past the screen.
- When Pi's own `Ctrl+V` path is converted, the editor cursor moves to the end.
- Other extensions that handle prompt images, such as an image sidecar store,
  still run after this one and may show their own previews.
