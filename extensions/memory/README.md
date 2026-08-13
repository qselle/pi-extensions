# memory

Stores explicit project or global notes that Pi can retrieve across sessions. It does not learn from transcripts or inject stored notes automatically.

Memory is disabled by default.

## Usage

```text
/memory enable
/memory disable
/memory status
/memory search <query>
/memory read <id>
/memory remember [--project|--global] <text>
/memory forget <id>
```

Run `/memory enable`, then `/reload`, to expose the model tool. Disabling blocks access immediately but does not delete stored records.

Agent tool:

The `memory` tool supports `status`, `search`, `read`, `remember`, and `forget`. Model-initiated writes and deletes require confirmation by default. Slash commands count as direct user intent and work without a dialog.

Search reads the current project and global scope. It returns IDs and bounded snippets; `read` fetches one record. Project records from other repositories are never included.

## Configuration

`$PI_CODING_AGENT_DIR/memory.json`:

```json
{
  "enabled": true,
  "defaultScope": "project",
  "confirmToolMutations": true,
  "maxSearchResults": 8
}
```

`maxSearchResults` is limited to 1–20. A malformed config stays disabled and is not overwritten.

Records are stored under `$PI_CODING_AGENT_DIR/memory/`:

```text
memory/global.json
memory/projects/<repo-name>-<root-hash>.json
```

Files are versioned JSON and may be inspected or backed up. Writes use atomic replacement. Symlinked stores and malformed or newer formats are rejected.

## Dependencies and limitations

- One record: 4,000 characters and up to 12 tags.
- Search: 8 results by default, 20 maximum, with 500-character snippets.
- Optional expiry hides stale records from normal search without deleting them.
- Common credential and private-key patterns are rejected, but detection is not complete. Review text before saving it.
- Global records are intentionally visible from every project.
- `forget` removes a record from the current file, not from backups or filesystem snapshots.

There is no network access, telemetry, embedding service, or automatic session analysis.

- Uses Pi's public extension API, Node.js standard-library modules, and host-provided `typebox`.
- No third-party runtime packages or external services.
- Cross-platform. Owner-only modes are requested on Unix; Windows relies on filesystem ACLs.
- Atomic updates require same-directory rename support.
