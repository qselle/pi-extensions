# memory

An explicit, local memory for Pi. Memories are user-managed records that can be
searched across sessions without loading prior conversations into every model
request.

The extension follows Pi's minimal/context-visible philosophy:

- the model tool and storage access stay disabled until `memory.json` explicitly enables them
- no session transcript is scanned or learned automatically
- no memory record is inserted into model context until the `memory` tool returns it
- records live in ordinary local JSON files that the user can inspect, edit, back up,
  or delete
- model-initiated mutations require confirmation when Pi has a UI; slash commands
  provide a direct, explicit path for headless use

## Design

### Progressive disclosure and context budget

The model receives only the small `memory` tool definition and its usage rule. Memory
contents are never added by `before_agent_start`, `context`, or a hidden system-message
hook.

Retrieval has three layers:

1. `status` reports counts and storage paths without record contents.
2. `search` returns bounded snippets and record IDs.
3. `read` returns one bounded record selected by ID.

Search defaults to at most 8 results, is capped at 20 results, limits each snippet to
500 characters, and caps the complete textual result. A single record is limited to
4,000 characters. These bounds prevent a memory lookup from becoming an accidental
conversation-history dump.

### Storage layout

The root defaults to `$PI_CODING_AGENT_DIR/memory` or
`~/.pi/agent/memory`:

```text
memory/
├── global.json
└── projects/
    └── <repo-name>-<root-hash>.json
```

Each file is a versioned JSON document containing records for exactly one scope. A
record contains:

- a random stable ID
- user-supplied text and optional tags
- scope (`global` or one canonical project root)
- explicit provenance (`cwd`, Pi session ID when available, and `explicit` source)
- creation/update timestamps
- an optional expiration timestamp

Project identity is the nearest ancestor containing `.git`, falling back to the
current working directory. The generated filename combines a readable basename and a
hash of the absolute project root, so identically named repositories remain isolated
and no project path is interpreted as a storage path.

Mutations use a read-modify-atomic-rename flow and Pi's shared file-mutation queue when
the host exports it; compatible older hosts use the extension's per-file in-process queue.
Existing symlinked memory directories/files are rejected rather than followed. Malformed or
unsupported files fail closed and are never silently overwritten.

### Scopes

- `project` is the default write scope. Reads can see only the current project and
  global memory.
- `global` is for preferences or workflows intentionally shared across projects.
- `all` is a read-only selector combining current-project and global results; it never
  exposes records belonging to a different project.

Project scope is an isolation boundary, not a security sandbox. Anyone who can read the
agent directory can read every memory file.

### Provenance and staleness

Every result identifies its scope, record ID, updated time, and project root where
applicable. Search ranking favors textual relevance and then recent updates; it does
not claim that old records are still correct.

`remember` may set `expires_in_days`. Expired records remain inspectable through
`status` and explicit reads but are excluded from normal search. The extension does not
silently rewrite or refresh facts. Users should forget, replace, or manually edit stale
records, and the model should verify drift-prone facts against the current repository
before relying on them.

### Automatic-learning boundary

Automatic session learning is intentionally outside the initial implementation.
A Codex-style background pipeline would require transcript selection, nested model calls,
secret redaction, deduplication, consolidation, staleness/forgetting rules, usage
accounting, and clear observability. Running that pipeline after every session would add
cost and could turn assistant guesses or prompt-injected content into durable state.

A future experiment is acceptable only if it is:

- disabled by default and separately opted into
- bounded by age, session count, tokens, concurrency, and cost
- visible while running and attributable to source sessions
- staged into reviewable candidate memories before promotion
- secret-redacted and able to no-op on low-signal sessions
- cancellable, testable, and never recursively trained from generated memory

Until those constraints are implemented and reviewed, only explicit `remember` requests
create durable records.

## Threat model and privacy

Memory is trusted local user state, not authoritative current truth.

| Risk | Mitigation | Remaining limitation |
|---|---|---|
| Hidden context growth | No automatic content injection; bounded search/read results | The tool definition itself consumes a small fixed prompt cost |
| Accidental or model-invented writes | Mutations are described as explicit-only; tool calls ask for UI confirmation | Slash commands are trusted as direct user intent |
| Secrets persisted forever | Common credentials/private keys are rejected; transcripts are never copied automatically | Heuristics cannot recognize every sensitive value; inspect text before confirming |
| Cross-project leakage | Per-root hashed files; current project can access only itself plus global scope | Global records are intentionally shared |
| Path traversal/symlink attacks | Generated paths only, canonical scope checks, symlink rejection, atomic writes | The agent directory is not a security boundary against the local user |
| Corrupt or newer formats overwritten | Parse/version errors fail closed | Repair requires editing or removing the affected file |
| Stale guidance | Timestamps, optional expiration, provenance, explicit forget | Non-expired facts can still drift and must be verified when risk warrants |
| Prompt injection preserved as memory | No automatic capture; the confirmation shows the proposed text | A user can explicitly save unsafe instructions, so stored content is still data to assess |

The files are created with owner-only modes where supported. There is no network access,
telemetry, embedding service, or third-party runtime dependency. Deleting a record
rewrites the file so forgotten text is not retained in an append-only tombstone, though it
may remain in filesystem snapshots or backups outside the extension's control.

## Commands

`/memory` is a direct, model-free interface. Before first use, opt in with `/memory
enable`, then run `/reload` so the model receives the memory tool. Calling `remember` or
`forget` this way is itself the explicit user consent, so it also works in print/JSON
mode without a dialog.

```text
/memory enable
/memory disable
/memory status
/memory search <query>
/memory read <id>
/memory remember [--project|--global] <text>
/memory forget <id>
```

Examples:

```text
/memory remember The focused test command is bun test extensions/memory
/memory remember --global Prefer concise final answers with file paths
/memory search focused test command
/memory read m_12345678-1234-1234-1234-123456789abc
/memory forget m_12345678-1234-1234-1234-123456789abc
```

`enable` and `disable` persist the capability setting in `memory.json`; they do not create,
change, or delete anything under the `memory/` store. Enabling makes slash-command access
available immediately, but `/reload` is required to expose the tool to the model. Disabling
blocks storage access immediately, persists across future discussions, and requires
`/reload` to remove the now-inert tool definition from the current model context. It is not
a session-only toggle; re-enable later to use the same stored records.

`status` shows active/expired counts and exact storage paths without loading record
contents. `search` looks in current-project plus global memory and returns ranked snippets
and IDs. `read` opens one ID. Command-form `remember` supports plain text and scope;
tags and expiry are available through the tool or by carefully editing the JSON file.

## Model tool

The extension registers one `memory` tool with these actions:

| Action | Inputs | Behavior |
|---|---|---|
| `status` | none | Show scope counts and paths, not record contents |
| `search` | `query`; optional `scope`, `max_results`, `include_expired` | Return bounded ranked snippets from `project`, `global`, or `all` |
| `read` | `id`; optional `scope` | Return one bounded record with provenance and staleness |
| `remember` | `text`; optional `scope`, `tags`, `expires_in_days` | Add or refresh an exact record after mutation consent |
| `forget` | `id`; optional `scope` | Remove an exact record after mutation consent |

Ask naturally, for example, “remember for this project that releases require the smoke
test” or “forget memory `m_…`.” With the default configuration, a model-initiated write
or deletion displays the exact proposal and requires confirmation. In headless modes a
model tool cannot obtain that confirmation; use the explicit slash command instead.

An exact repeated `remember` refreshes the existing record rather than creating a
duplicate. Supplying tags replaces its tags; supplying `expires_in_days` refreshes the
expiration. `scope=all` is read-only and is rejected for writes.

## Configuration

`/memory enable` creates or updates `~/.pi/agent/memory.json`, or
`$PI_CODING_AGENT_DIR/memory.json` when that environment variable is set. The command
preserves other fields and writes the file atomically with owner-only permissions where
supported. A malformed existing config is never overwritten automatically.

You can also create or edit the file manually:

```json
{
  "enabled": true,
  "defaultScope": "project",
  "confirmToolMutations": true,
  "maxSearchResults": 8
}
```

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `false` | Explicit opt-in that registers the model tool. Use `/memory enable` or `/memory disable`; while false, `/memory status` remains available but no memory content can be read or changed. Run `/reload` after changing it. |
| `defaultScope` | `"project"` | Write scope used when `remember` does not specify `project` or `global`. |
| `confirmToolMutations` | `true` | Require TUI/RPC confirmation for model-initiated `remember` and `forget`. Setting this to `false` explicitly permits headless model mutations and removes an important guardrail. |
| `maxSearchResults` | `8` | Per-call result ceiling, clamped to 1–20. A tool request can lower but not raise this configured limit. |

A missing or malformed config stays disabled. Run `/memory enable`, then `/reload`, to opt
in. `/memory disable` leaves all record files untouched while blocking access; reloading
then removes the tool definition and its fixed prompt cost entirely. Both settings persist
across future Pi discussions.

## Manual inspection and repair

The stores are intentionally editable, but malformed data fails closed. Before manual
changes, stop concurrent Pi mutations and preserve:

- top-level `version: 1`, matching `scope`, and an `entries` array
- unique IDs beginning with `m_`
- canonical ISO timestamps such as `2026-01-02T03:04:05.000Z`
- record text up to 4,000 characters and at most 12 tags
- `source.kind: "explicit"` and a source `cwd`

A project store embeds its absolute project root; copying it to another generated project
filename does not change its scope. To recover from corruption, repair the JSON or move the
file aside. The extension will not overwrite an unreadable/newer store.

## Codex comparison

[Codex's memory pipeline](https://github.com/openai/codex/tree/main/codex-rs/memories)
extracts eligible prior rollouts in the background, stores stage-one outputs, and runs a
second model-backed consolidation phase that produces a prompt-loaded summary, handbook,
skills, and rollout summaries. It includes strong ideas—progressive disclosure, provenance,
secret redaction, citations, ranking, pruning, and explicit ad-hoc notes—but also needs a
state database, background leases, nested model calls, consolidation agents, and automatic
developer-prompt injection.

This extension deliberately adopts only the small, Pi-compatible subset:

- file-backed, searchable records
- global/project scope, provenance, expiry, bounded reads, and explicit deletion
- a tiny retrieval tool instead of an always-loaded memory summary
- user-confirmed writes instead of background transcript extraction

It therefore remembers less automatically than Codex, but every durable mutation and every
piece of retrieved context stays observable and under user control.

## Dependencies and platform limitations

- **Runtime:** Pi's public extension API, `typebox`, and Node.js standard-library modules
  supplied by the host.
- **Third-party runtime packages:** None.
- **Network/services:** None; no embeddings, telemetry, or remote database.
- **Platforms:** The implementation is OS-neutral and uses no external command. It is tested
  on the repository's Bun test runner. Atomic replacement relies on same-directory filesystem
  rename semantics available on supported Node.js platforms.
- **Permissions:** Owner-only `0700` directories and `0600` files are requested. Windows and
  filesystems without POSIX modes may ignore those bits; rely on the account/filesystem ACLs.
- **Symlinks:** Existing symlinked memory roots, project directories, and store files are
  rejected. This is tested on Unix; Windows symlink creation and permission behavior depend on
  host policy.
- **Backups:** `forget` removes text from the current JSON store, not from Time Machine,
  snapshots, cloud backups, undelete tools, or copies made elsewhere.
