# handoff

Hand off work to a new Pi session that starts from a summary of the current
one instead of a copy of its history. Unlike `/fork` and `/clone`, the new
session does not re-send or re-count the parent's tokens, and ownership is
explicit: the new session owns the task and the parent is told so.

## Usage

```text
/handoff          Hand off this session's work
/handoff <task>   Hand off one task, e.g. /handoff fix the flaky test
```

In Herdr, `/handoff` asks where to open the new session: the current pane, a
new pane to the right or below, a new tab, or a new workspace. Outside Herdr it
switches the current pane.

The current model writes the summary by calling the `handoff` tool, continuing
its cached conversation instead of re-reading it in a separate request. The new
session gets that summary as its only context, with the task, the parent session
file for details the summary omits, and the model and thinking level. With a
task it starts working at once; without one it waits for your prompt.

The tool result stays in the parent: it names the new session and tells the
model not to continue that work. The parent keeps running in a new pane, tab, or
workspace; in the current pane it remains in Pi's session list, linked as the
new session's parent.

You can also ask the agent directly, e.g. "hand off the admin panel to a new
tab". It then asks for a new pane, tab, or workspace; switching the current
pane needs `/handoff`.

## Dependencies and limitations

- Pi 0.87.0 public command, tool, and session APIs; no runtime packages.
- New panes, tabs, and workspaces require a Herdr-managed Pi. Herdr starts `pi`
  from the pane's `PATH` and waits up to 30 seconds for it. If Pi does not
  start, the new pane, tab, or workspace and the new session are removed; if
  Herdr cannot close it, the session is kept for the Pi that may be running.
- The summary is written by the model and may omit facts. Files, background
  jobs, and other extension state are not transferred.
- Handing off waits for the current run and queued messages to finish, and
  needs at least one message and a selected model.
