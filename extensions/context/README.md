# context

Shows how the current model context is divided between the system prompt, tool schemas, and conversation.

## Usage

```text
/context    Append a report to the transcript
Ctrl+O      Expand or collapse detailed rows (default binding)
```

A report includes:

- Pi's authoritative used/window total
- system-prompt components such as Pi instructions, guidelines, context files, and skills
- active tool schemas, grouped by tool
- conversation entries, including extension context grouped by `customType`
- the largest individual entries
- the independent estimated total and the latest provider usage components

Rows use Pi's token estimator. The headline uses `getContextUsage()`, which is the value Pi uses for compaction.
When that value is unavailable (including after compaction), the headline says
`Estimated`; a reported zero remains `Used 0`. Differences are shown instead of forced to reconcile.

Display columns are Unicode-aware, including wide glyphs and combining marks.

The report is a non-context transcript entry. It stores labels and counts, not context-file or skill contents. In non-TUI modes it is returned as a plain notification.

## Dependencies and limitations

- Uses Pi's public extension, session, tool, context, and token-estimation APIs.
- Pi 0.86 transcript system messages are excluded from conversation totals because
  the current prompt and tool schemas are already counted separately. Historical
  prompt/tool revisions retained by a provider are not separately estimated; the
  authoritative host total can therefore differ. Cache-warming usage is not context.
- No third-party packages or external services.
- Cross-platform; detailed rendering requires the TUI.
