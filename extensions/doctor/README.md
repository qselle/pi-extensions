# doctor

Read-only local health checks with concrete fixes for missing dependencies and
configuration errors. Credentials, filesystem paths, and raw parser errors are
never included in the report.

## Usage

```text
/doctor        Scrollable, searchable health report in the TUI
/doctor text   Plain report, also used automatically outside the TUI
```

Checks the supported Pi host version, global settings JSON, model-registry error
and authentication metadata, duplicate custom key assignments, the resolved shell, loaded/active research and job tools, default Exa access
and optional search credential presence, ax availability, PTY setup, cleanup limitations, Telegram configuration,
notification and rendering settings, editor accents, hyperlink modes, and platform
helpers for banners and macOS sleep prevention. It also reports optional image-history
and context-journal tool activation, the current fast-mode transport gate, and
coordinated-reload command availability. Optional integrations are checked only when their tools/commands are
loaded. Missing optional services do not block other features.

Search defaults to keyless Exa, so a missing API key is not a configuration warning.
Explicit `PI_EXA_ACCESS=api-key` plus a key selects direct API access; Firecrawl and Mistral remain explicit choices.
The report makes no requests and does not verify connectivity, rate limits or credit balances.

Notification checks follow the terminal's supported delivery route. A terminal
with supported OSC notifications does not need `osascript` or `notify-send` on the
Pi host. Linux sessions without a display or session bus show native banners as
inactive instead of recommending desktop packages. Terminal permissions, tmux
passthrough settings and actual delivery are still unverified.

The report opens at an overview with counts, followed by warnings and their fixes,
passed checks, then inactive integrations. Warning labels use the theme's warning
color; inactive services are not reported as failures. `/doctor text` uses the
same ordering and counts.

The report uses the transcript viewer's scrolling and search controls. It is a
snapshot: rerun `/doctor` to refresh the checks. Closing, replacing a session, or
changing branches releases the view; late checks and panel callbacks are discarded.
Reports are not saved or sent to the model.

## Dependencies and limitations

- The supported host check accepts Pi 0.87.0 through 0.87.x.
- Pi public tool inventory, command, shell, and UI APIs; Node.js filesystem APIs.
- Uses the shared `lib/transcript` viewer and secure Telegram configuration reader;
  enabling those UI extensions is not required.
- Performs metadata/file checks only. It never launches a command, loads a native
  PTY module, sends a notification, contacts a service, or modifies configuration.
- Optional context tools being inactive is reported as off, not a setup error.
  Fast-mode checks do not establish account eligibility or actual service tier.
  Reload checks do not probe registration, socket permissions or peer connectivity.
- Finding a binary does not verify its version or functionality. Credentials are
  checked for presence/local format only, not provider authentication or delivery.
- JSON setting reads are bounded to 64 KiB; symlinks and non-regular config files
  are rejected. Telegram applies its own stricter ownership/permission checks.
- Supports macOS, Linux, and Windows; the report identifies platform limitations.
  Windows executable discovery checks common executable suffixes, not arbitrary
  file associations. PTY package detection on Linux/Windows does not verify a
  native build; macOS additionally checks its executable spawn helper.
