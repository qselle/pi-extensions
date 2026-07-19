# file-cards

Self-contained, syntax-highlighted cards for Pi's native `edit` and `write` tools.

```text
╭─ ✓ EDIT src/example.ts +1 -1 ────────────────────────────────────────╮
│ 1 · export function value() {                                        │
│ 2 -   const answer = 41;                                             │
│ 2 +   const answer = 42;                                             │
│ 3 ·   return answer;                                                 │
│ 4 · }                                                                │
╰─ applied · TypeScript ───────────────────────────────────────────────╯
```

The card owns its complete border and updates in place from pending to settled. It does not append a second result panel after the edit completes.

## Behavior

- Re-registers only the native `edit` and `write` names to replace their TUI presentation.
- Delegates schemas, argument preparation, prompt guidance, execution, mutation queues, result text, patches, and errors to Pi's current built-in tools.
- Detects the language from the target filename and uses Pi's public syntax highlighter.
- Shows line-numbered edit diffs with clear context, addition, and removal gutters.
- Shows line-numbered content for complete file writes.
- Displays the path, operation state, line or byte totals, diff totals, and detected language inside one bordered card.
- Updates the same component when the operation settles, so transient and final output cannot stack into duplicate cards.

No command or configuration is required.

## Bounded layout

The renderer is deliberately unable to consume the full terminal:

| Mode | Maximum body rows | Maximum total rows |
|---|---:|---:|
| Collapsed | 9 | 11 |
| Expanded (`app.tools.expand`, normally `Ctrl+O`) | 20 | 22 |

Cards are at most 96 columns wide and shrink responsively on narrower terminals. Long lines are ANSI-aware and truncated within the border rather than soft-wrapping into extra terminal rows.

When a diff is taller than the budget, changed lines from distant hunks are prioritized before nearby context. Omission rows and the footer report hidden content. Expanded mode reveals more context but remains bounded; the complete patch still remains in the native tool result for the model and session.

## Syntax highlighting

Language detection follows Pi's built-in `getLanguageFromPath()` mapping. Recognized extensions use Pi's active syntax theme, including multi-line code passed to the highlighter as a block. Unknown and extensionless files fall back to the normal tool-output palette.

Highlighting is presentation-only. File bytes are never reformatted or transformed.

## Compatibility

Pi permits extensions to override built-in tools by registering the same name. If another enabled extension also replaces `edit` or `write`, whichever registration Pi loads last controls those tools. Avoid enabling competing native-tool restylers at the same time.

The card affects interactive transcript rendering only. JSON, RPC, and print consumers continue to receive Pi's native tool-call and tool-result data.

## Dependencies and limitations

- **Runtime:** Pi's public extension and TUI APIs.
- **Third-party packages:** None.
- **Platforms:** Cross-platform; no OS-specific behavior.
- **Tools affected:** `edit` and `write` only.
- **Language detection:** Filename-extension based; unknown formats are displayed without syntax token colors.
