# Gruvbox dark

A warm dark palette for Pi's transcript, thinking, tools, menus, editor, Markdown,
syntax highlighting, diffs and HTML exports. Select `gruvbox-dark` in `/settings`.
Run `/reload` after updating this package's theme.

The theme uses cream body and tool text on a charcoal base. Thinking uses a
slightly softer cream, so it stays readable without competing with the final
answer. User messages sit on a distinct warm gray panel (`#504945`) with brighter
cream text (`#fbf1c7`), making each request easy to spot. Pi's native padding gives
the panel a blank row above and below the message. Neutral borders and an
almost-neutral olive success background keep tool output quiet. Orange marks interaction and selection;
yellow marks warnings; red text and a dark red panel mark failures.

Shell commands use the softer `toolPendingBg` surface (`#3c3836`) throughout
execution, with a quiet left gutter. The command panel stays visually separate
from its output and quieter than the user-message panel; completion does not
turn the entire command green.

The footer and turn receipts use orange for their primary identity or duration,
warm gray for labels and cream for values. Normal cache, token and Git values
stay neutral; warning/error colors are reserved for actual pressure, incomplete
accounting or failures. Labels such as `context`, `cache hit` and `first token`
remain readable when lower-priority fields are hidden to fit one line.

Code uses distinct roles: red keywords, yellow functions, blue variables, green
strings, purple numbers, aqua types and orange operators. Comments remain
readable in warm gray. Unrecognized code languages use the normal cream code
color. Markdown fences, quote borders and rules stay subdued.

Pi applies these colors through its public theme tokens. Native thinking keeps
Pi's italic styling; its visibility is controlled with `hideThinkingBlock` or the
native thinking toggle. `markdown.codeBlockIndent` controls code indentation, and
`outputPad` controls horizontal message padding. This theme adds no commands,
runtime dependencies, code grammars or text transformations.

For the intended appearance, use a dark terminal background near `#282828`.
Pi does not repaint the terminal's default background from the theme's `bg0`
palette variable; that value also anchors HTML export colors. Truecolor terminals
show the exact palette, while 256-color terminals approximate it. Text contrast
tests use the intended background and explicit message/tool panel colors.

See Pi's [theme documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md)
and [settings documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)
for supported controls.
