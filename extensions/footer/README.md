# footer

Replaces Pi's footer with a compact two-zone status line: session and runtime telemetry stay on the left while the current directory and Git branch remain anchored on the right.

```text
Footer refresh · gpt-5.6-sol high · ● ready · ctx 94% left · 28.2K/258K · ↓96K ↑521 · $0.21          ~/pi-extensions · main
```

## Usage

The main row can show:

- session name, model, and thinking effort
- optional extension badges
- ready or working state
- remaining context plus used/window tokens
- cumulative input, output, and provider-reported cost
- right-aligned directory and Git branch

Narrow terminals remove secondary details before model and remaining-context information. Long workspaces preserve both the repository tail and the beginning of the branch name. Statuses published through `ctx.ui.setStatus()` remain on a separate second row so temporary progress never displaces the main footer.

When a routed model name exceeds the available row, it is shortened before
remaining context disappears. On extremely small widths the context label takes
precedence. Context is green below 75% used, yellow from 75%, and red from 90%;
unknown measurements use a muted color.

Usage is scanned once and cached until a message, compaction, or branch change invalidates it. Totals include assistant responses, nested model usage on tool results, summaries, and compactions.

The terminal title shows the session and project. A low-frequency Braille spinner is active only while Pi is working. Attention UI such as `questionnaire` temporarily owns the title and the footer restores the appropriate active or idle title afterward.

### Extension badges

Optional extensions can publish a short first-line badge through Pi's event bus:

```ts
pi.events.emit("footer:badge", { id: "fast-mode", text: "fast", order: 10 });
pi.events.emit("footer:badge", { id: "fast-mode" }); // remove
```

Badge IDs and labels are sanitized and bounded. Re-emitting an ID replaces it; `order` controls stable placement.

## Dependencies and limitations

- Uses Pi's public footer, terminal-title, context, model, session, lifecycle, and event-bus APIs.
- Uses only Node.js standard-library modules; no third-party runtime packages.
- Interactive TUI only; cross-platform.
- Context fields show `?` until Pi has a usable context measurement, such as immediately after compaction.
- Pi exposes no previous terminal title, so shutdown restores the neutral title `pi`.
