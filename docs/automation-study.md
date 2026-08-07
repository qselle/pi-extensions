# Automation study: loops, monitors, and schedules

Reviewed on 2026-08-08 against current product documentation and public implementations.

## Why three extensions

The useful boundary is not syntax; it is execution semantics:

| Layer | Best for | State | Model cost | Runs while Pi is closed |
|---|---|---|---|---|
| [`loop`](../extensions/loop/) | Re-checking and advancing a conversational task | Session transcript | One turn per iteration | No |
| [`monitor`](../extensions/monitor/) | Watching deterministic command state | Session transcript | Only on an actionable observation | No |
| [`schedule`](../extensions/schedule/) | One-shot reminders and calendar recurrence | Atomic project queue in Pi's agent directory | One turn per delivery | No; overdue work catches up |

Keeping these separate prevents a convenient short-session loop from quietly becoming a daemon,
and prevents unchanged command polling from burning model turns.

## Comparative findings

### Claude Code

Claude's `/loop` is the closest interaction model: fixed or model-chosen cadence, a bare bounded
maintenance prompt, project/user `loop.md`, one-shot tasks, five-field cron, idle delivery, and a
hard task cap. Its Monitor path is more token-efficient than model polling. Claude also explicitly
separates in-session `/loop` from Desktop and cloud Routines that survive independently.

This package now matches the high-value local pieces: bare/interval-only maintenance, live prompt
reload, fixed and dynamic pacing, interruption/error pausing, deterministic monitoring, reminders,
five-field timezone-aware cron, caps, coalescing, and visible task state. It intentionally does not
claim cloud or closed-app execution.

Source: [Claude Code scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks).

### OpenAI Codex

Codex's strongest differentiators are product-level orchestration: recurring automations can
return to the same thread, results are surfaced for review, and the app has first-class sandbox and
worktree support. That is broader than an in-process Pi extension can safely reproduce.

The local implementation adopts the same reviewable separation of session continuation and
calendar automation, but scheduled turns remain in the current project checkout. Worktree or VM
isolation belongs in a supervising app/runner, not an implicit slash-command side effect.

Sources: [Codex automations](https://openai.com/academy/codex-automations/),
[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

### Pi ecosystem

Public Pi implementations validate two design directions:

- monopi/oh-pi persists reminders and recurring prompts while Pi is active and idle, with explicit
  ownership scopes and a separate background-task runtime.
- pi-interactive-shell uses structured monitor triggers and wakes the model only on matching
  events instead of polling it continuously.
- pie adds serialized cron turns, missed-tick coalescing, stateful loop notes, and a triage inbox.

This package chooses a smaller surface: explicit user-created shell monitors, hashed observation
deduplication, transcript-scoped monitor state, and a project scheduler with an exclusive process
lease. A separate triage inbox and continuously streaming PTY monitor remain sensible future work,
but would be different products rather than hidden expansion of `/loop`.

Sources: [monopi](https://github.com/ifiokjr/monopi),
[pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell),
[pie](https://github.com/c4pt0r/pie).

### Angristan's Netclode

Netclode's relevant lesson is control-plane discipline, not a particular loop command. It combines
persistent session state, explicit sandbox lifecycle, crash reconciliation, error states, scoped
GitHub credentials, microVM isolation, and secret injection outside the sandbox.

The scale is intentionally different here, but the same principles shaped the scheduler: durable
pending-delivery state before wakeup, reconciliation after restart, explicit interruption states,
single-owner delivery, owner-only files, no stored secrets, and no claim of isolation that the Pi
extension cannot actually provide.

Sources: [Building a self-hosted cloud coding agent](https://stanislas.blog/2026/02/netclode-self-hosted-cloud-coding-agent/),
[angristan/netclode](https://github.com/angristan/netclode).

## Current position

The package is now stronger than a direct `/loop` clone for local interactive work because it has
three explicit cost/durability tiers and defensive persistence. It is still deliberately below a
Codex Desktop, Claude Routine, or Netclode control plane in four areas:

1. no execution while Pi is closed;
2. no isolated worktree, container, or microVM per scheduled run;
3. no global review inbox or per-run artifact history;
4. no external event gateway for webhooks.

Those gaps require a supervising runtime with its own lifecycle, credentials, logs, and isolation.
Adding them inside an ordinary session extension would weaken the safety and reliability story.
