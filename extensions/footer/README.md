# footer

A readable **single-line** footer. The model uses the theme accent; normal labels,
values and workspace details stay neutral. Quiet dots separate related groups.

```text
 GPT-5.6 Sol high │ context 6% 15.5K/258K · in 1.2K out 521 · cache R 8.4K W 400 hit 84% · $0.21 │ pi-extensions · main
```

## Usage

Enabled automatically when this extension is loaded. Use `/reload` after updating.

The line can show model and reasoning effort, session name, model badges,
context, usage, cost, directory, Git branch/change counts, and extension statuses.
It never adds a second row, even when extensions publish long statuses.
Reasoning is omitted when off or unsupported.

The metric labels are:

| Label | Meaning |
| --- | --- |
| `context 6% 15.5K/258K` | Used context percentage, measured tokens and model capacity |
| `in 1.2K out 521` | Fresh input and output tokens |
| `cache R 8.4K W 400 hit 84%` | Cache tokens read (`R`), written (`W`), and cache-hit percentage |
| `$0.21` | Cumulative recorded cost |

Cache metrics share one label, with spaces separating each counter from its value.
The hit rate is cache reads divided by fresh input plus cache reads and writes.
That cumulative prompt total is not shown separately because it repeats these
counters; `context` remains the current context measurement.

Wide terminals preserve detailed metrics. Session/status
metadata gives way first, followed by optional cache details. Workspace
identity stays on the right; paths and branches shorten before disappearing.
Narrow layouts retain the model, context percentage and cost, then use available
space for other fields. Cache writes give way before reads, then the remaining
`cache hit` field disappears as a unit. The `cache` label always stays with its
counters; other metric labels keep their readable words.
The model retains its reasoning effort when shortened; conflicts outlast ordinary
Git details and other optional fields. A final cell-aware clip handles exceptionally
tiny widths.

Measured-zero cache read/write counters are omitted. A measured cache-hit
rate of `0%` remains visible when prompt tokens were reported without cache reads.
Missing usage fields show `?` (`$?` for cost); partial totals show a yellow `≥` lower
bound. The cache-hit rate is unknown whenever a prompt component is incomplete.
These are recorded cumulative figures, not estimates of provider billing or missing
usage. Detailed per-run accounting remains available through `turn-stats`.

Extension statuses share the same row, sorted by key. They disappear before usage
metrics when space is limited. Control sequences and newlines are stripped from
labels. The working indicator and terminal title continue to show activity.

Context uses Pi's reported **used** percentage and token count. It becomes yellow
from 75% used and red from 90%; unknown measurements show `?`. Normal cache use,
cost, Git changes and activity badges do not add accent or warning colors.

Git telemetry uses full labels, such as `git staged 2 changed 3 new 1 ahead 2 behind 1`.
They mean staged paths, modified paths, untracked entries, and commits ahead/behind
the local upstream reference. Empty counts disappear; clean repositories add no
clutter. Actual `conflicts 1` use a red count and survive width reduction longer
than other optional details. Untracked directories count as one entry; a path
changed in both the index and worktree contributes to both staged and changed
counts. These are path counts, not line diffs.

Git status refreshes after tool completion, branch changes, and run boundaries.
Events coalesce for 500 ms and only one check runs at a time per session; no
processes start during rendering or periodic idle polling. Checks time out after
two seconds and are cancelled on reload, shutdown, or footer disposal. Missing
Git, non-repositories, and failed checks quietly omit the telemetry. Changes made
outside Pi become visible at the next refresh event. Upstream distance uses local
refs; the extension never fetches from a remote. Model and effort changes redraw
immediately.

Usage is cached until a lifecycle event or the session branch leaf changes. Totals
include fresh/cached/written input and output from assistant responses, nested model usage on tool results, summaries,
compactions, cache-warming usage, and recorded child-agent response deltas. Child
usage shares the main counters and cost; it does not add a separate status group.
The context window and percentage always describe the parent conversation.
Child responses refresh the footer even while the parent is idle. Reloads and
branch navigation restore only usage recorded on that branch; cumulative child
snapshots and repeated references to the same saved entry are not counted again.
Missing child metrics retain the same unknown/lower-bound treatment as parent
usage. Older records retain the values originally saved.
Idle warming costs appear on the next
footer render without waiting for another assistant response.

The terminal title shows the session and project. A low-frequency Braille spinner is active only while Pi is working. Attention UI such as `questionnaire` temporarily owns the title and the footer restores the appropriate active or idle title afterward.

### Extension badges

Optional extensions can publish a short inline badge through Pi's event bus:

```ts
pi.events.emit("footer:badge", { id: "fast-mode", text: "fast", order: 10 });
pi.events.emit("footer:badge", { id: "fast-mode" }); // remove
```

Badge IDs and labels are sanitized and bounded. Re-emitting an ID replaces it; `order` controls stable placement.

## Dependencies and limitations

- Uses Pi's public footer, terminal-title, context, model, session, lifecycle, and event-bus APIs.
- Uses only Node.js standard-library modules; no third-party runtime packages.
- Optional Git executable with porcelain v2 support for change telemetry.
- Interactive TUI only; cross-platform.
- Context fields show `?` until Pi has a usable context measurement, such as immediately after compaction.
- Pi exposes no previous terminal title, so shutdown restores the neutral title `pi`.
