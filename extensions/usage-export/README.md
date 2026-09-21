# usage-export

Export recorded token usage and cost to a local JSON or CSV file on demand. Nothing is collected in the background or sent over the network.

## Usage

```text
/usage-export branch json                  Preview current-branch totals
/usage-export branch json usage.json       Export the current branch
/usage-export session csv "all usage.csv"  Export every branch in this session
```

Choose a new destination: existing files and symlinks are never overwritten. Relative paths use the current workspace; absolute paths and `~/` are supported. Parent directories must already exist. New files request owner-only permissions on systems that support them.

Each record contains the entry ID, timestamp, source kind, available provider/model/stop reason, input/output/cache-read/cache-write/total tokens, and recorded total cost. Assistant responses with missing usage remain in the report. Tool-result, compaction, branch-summary and this package's `subagent-usage` records are included when explicitly recorded. Child-agent task text and names are excluded. Duplicate entry IDs count once.

JSON includes the export scope, generation time, records, and totals with a separate missing-record count for every metric. Missing or invalid values are `null`; known zero stays zero. CSV contains one row per record with blank missing values and quotes/escapes metadata. Formula-like text is prefixed with an apostrophe for spreadsheet safety.

## Dependencies and limitations

- Uses Pi's public session API and Node filesystem APIs; no third-party dependencies.
- Works in interactive and headless command contexts; cross-platform. Filesystem permissions depend on the platform.
- Standalone usage entries, including cache warming, retain their category
  in `source` and their provider/model attribution. They are counted once per entry.
- Exports a snapshot of entries already recorded when the command runs. In-flight responses are not included. Whole-session scope includes abandoned branches; it does not scan other sessions or child-session files.
- Nested model usage appears only when the calling tool records it. Its original provider/model attribution may be unavailable, so those fields remain blank.
- Costs are Pi's recorded USD estimates, not invoices. Unknown fields are not inferred, and token totals are not reconstructed from partial categories.
- Prompts, response text, reasoning, tool arguments/results, workspace paths and credentials are not serialized. Provider/model names and entry timestamps are metadata included in the export; review before sharing.
- There is no automatic upload, recurring export, global usage database, or cross-session aggregation.
