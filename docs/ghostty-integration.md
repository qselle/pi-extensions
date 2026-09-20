# Ghostty integration research

Reviewed 2026-09-19. This is a design for later implementation, not an installed
extension or a claim of tested app automation.

## Local feasibility

The installed `/Applications/Ghostty.app` reports **1.3.1**, build **15212**.
Its bundle enables AppleScript and includes `Resources/Ghostty.sdef`. These facts
were obtained by reading `Contents/Info.plist` and parsing the dictionary; Ghostty
was not launched or controlled, and no terminal contents or user settings were read.

The installed dictionary exposes:

| Need | Available interface | Consequence |
|---|---|---|
| Identify panes | Read-only terminal, tab and window IDs | Store returned IDs, not positional indexes |
| Open beside a chosen pane | `split` with direction and surface configuration | Target an explicitly selected terminal |
| Start in a project | Surface configuration's initial working directory | Pass the path as data; avoid typing `cd` |
| Configure a launched process | Command, initial input, environment variables, wait after command | Command execution semantics still require a runtime test |
| Label a tab | Generic `perform action`; documented `set_tab_title` action | Label the returned target and check the action's boolean result |
| Focus or close | Explicit terminal/window/tab commands | Keep these separate from automatic status updates |
| Capture output or exit status | No such property or command in the installed dictionary | A pane alone cannot implement reliable managed-job accounting |

The official [AppleScript guide](https://ghostty.org/docs/features/applescript)
describes the object model and creation operations, dates support to 1.3.0, and
explains macOS Automation permissions. Installed dictionary support does not prove
that permission is granted or scripting has not been disabled in configuration.

## Proposed user workflow

1. `/ghostty status` reports local capability and whether a terminal is attached.
   Ordinary startup performs no Apple Events or permission prompts.
2. `/ghostty attach` explicitly lists candidate terminals for selection. Multiple
   panes with the same working directory must remain distinguishable by IDs and
   titles; matching the current directory is not sufficient proof of ownership.
3. `/ghostty split right|down` opens a shell in the current project and records the
   returned terminal ID. Revalidate the target before each operation. A vanished
   terminal produces an actionable error, never a fallback to the front pane.
4. `/ghostty title on|off` optionally mirrors the Pi session title to the attached
   tab. Coalesce changes, sanitize control characters, and avoid switching focus.
5. `/ghostty detach` releases integration state. Detaching or shutting down Pi
   leaves panes open. Closing a pane is an explicit action against an owned ID.

Use fixed AppleScript source with arguments supplied through `osascript`'s argument
vector. Paths, titles and IDs are data, never interpolated script source. An action
name is selected by extension code; arbitrary action strings are not model tools.
Cancellation must terminate the local helper, and a timed-out creation is an
uncertain result: inspect existing state before retrying to avoid duplicate panes.

## Managed commands need another layer

Retain `background-jobs` as the process owner and source of output, exit status,
redaction and cleanup. Do not infer job completion from a pane closing or a shell
prompt becoming visible. The installed scripting dictionary cannot supply that
information.

A later visible-job design could attach a pane viewer to the existing job service,
but it needs an authenticated local transport, reconnect semantics and explicit
ownership of input. It must not create two independent shells and present them as
one job. Until that transport exists, opening a project shell and launching a
managed background job remain distinct actions.

## Portability and shell behavior

AppleScript is a macOS integration. This research establishes no equivalent Linux
pane-control contract; Linux keeps the existing managed-job panel and terminal
links. Remote Pi sessions cannot assume they can address a local Ghostty instance.

Ghostty's [shell-integration guide](https://ghostty.org/docs/features/shell-integration)
describes directory tracking and environment detection. Neither directory equality
nor the presence of its resources variable identifies a unique pane. Shell
integration may be missing after switching shells, and macOS's bundled Bash needs
manual integration. Do not alter shell startup files to make detection work.

Existing Pi-managed titles and OSC 8 links remain independent of pane automation.
Their live click-through behavior must be tested in Ghostty rather than inferred
from successful string rendering tests.

## Acceptance checks before shipping

- Confirm macOS permission granted, denied, disabled scripting and missing-app paths
  without repeated permission prompts or startup failures.
- Select between two same-directory panes, change focus, then split only the
  selected target. Test closed/stale IDs and application restart.
- Pass directories and titles containing quotes, Unicode and newlines as data;
  reject control characters where the UI contract requires it.
- Verify returned pane IDs, initial directory, focus behavior, title updates and
  detach behavior with real Ghostty. Preserve unrelated tabs and windows.
- Exercise cancellation/timeouts during pane creation and check for an already
  created pane before retrying. Do not assume cancelling the helper undoes creation.
- Confirm that model tools cannot send arbitrary input to an existing unowned pane.
- Test SSH and Linux fallbacks independently. Do not describe macOS results as
  cross-platform validation.

The next implementation milestone is explicit attachment plus opening a project
shell. Visible managed-job control follows only after its transport is designed
and tested. No runtime code or user configuration has been changed by this study.
