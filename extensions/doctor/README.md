# doctor

Read-only checks for local dependencies and configuration, with suggested fixes.

## Usage

```text
/doctor        Scrollable, searchable health report
/doctor text   Plain report (also used outside the TUI)
```

Checks Pi version and settings, model authentication metadata, keybinding conflicts,
the shell, loaded tools, search credentials, ax, PTY setup, Telegram, rendering,
notifications, and macOS sleep prevention. Optional integrations are checked only
when loaded; disabled features are not errors. Exa uses its API key when present
and public access otherwise.

Resource checks validate the global `packages`, `extensions`, `skills`, `prompts`,
and `themes` list shapes, including package resource filters and `autoload`.
They flag repeated package sources/plain resource paths and missing explicit local
paths. Reports identify field names and counts without displaying configured paths
or package sources. Empty filters and repeated ordered include/exclude patterns
remain valid. Fix suggestions point to `settings.json` and `pi config`.

Warnings and fixes appear first, followed by passed checks and inactive features.
The panel uses the [transcript viewer's controls](../transcript/). Rerun the command
to refresh; reports are not saved or sent to the model.

## Dependencies and limitations

- Requires Pi 0.87.x; uses public Pi APIs and Node.js built-ins.
- Uses the shared transcript viewer and Telegram configuration reader; their UI
  extensions need not be enabled.
- Checks local metadata and files only. It does not run commands, load PTYs,
  contact providers, test notifications, or modify settings.
- Credentials, paths, and raw parser errors are omitted. Finding a binary or
  credential does not verify functionality, authentication, or account eligibility.
- JSON reads are capped at 64 KiB and reject symlinks and non-regular files.
  Telegram configuration has additional ownership and permission checks.
- Resource checks inspect global settings only. They do not resolve project
  overrides, compare npm/git versions, scan package contents, or detect every
  duplicate load through symlinks, auto-discovery, or different remote aliases.
  Existence checks cover absolute, `./`/`../`, `~/`, and `file://` paths using
  filesystem metadata; relative paths resolve from Pi's agent directory.
  Bare names, globs, ordered filters, package-internal paths, and Windows
  MSYS/WSL/Cygwin drive aliases are left to Pi. Permission failures are not called
  missing files. No resource code is loaded or executed.
- Supports macOS, Linux, and Windows. Windows discovery checks common executable
  suffixes. macOS PTY checks include the spawn helper's execute permission;
  other platforms only check that the package is present.
- Supported OSC notification terminals need no native notifier. Linux sessions
  without a display/session bus report native banners as inactive.
