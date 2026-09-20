import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SnapshotPanel } from "../../lib/transcript/snapshot-panel.ts";
import type { TranscriptBlock } from "../../lib/transcript/model.ts";
import type { ScheduledTask } from "./schedule.ts";

export function scheduleBlocks(tasks: readonly ScheduledTask[], writable: boolean, error?: string): TranscriptBlock[] {
  return [{ id: "queue", label: "Schedule queue", kind: "assistant", body: [
    error ? `Queue error: ${error}` : writable ? "Owner session" : "Read-only session",
    "Snapshot · /schedule pause|resume|stop <id> to manage tasks. Reopen to refresh.",
    tasks.length ? `${tasks.length} retained tasks` : "No scheduled tasks.",
  ].join("\n\n") }, ...tasks.map((task): TranscriptBlock => ({
    id: task.id, label: `${task.id} · ${task.status}`, kind: "assistant",
    body: [
      task.kind === "cron" ? `Cron: ${task.cronExpression} · ${task.timeZone}` : "One-shot reminder",
      `Runs: ${task.runs}/${task.maxRuns}`,
      task.nextRunAt === null ? "No next run" : `Next: ${new Date(task.nextRunAt).toISOString()}`,
      task.pendingDeliveryAt === undefined ? "No pending delivery" : `Delivery pending: ${new Date(task.pendingDeliveryAt).toISOString()}`,
      task.stopReason ? `Reason: ${task.stopReason}` : "",
      task.prompt,
    ].filter(Boolean).join("\n\n"),
  }))];
}

export class SchedulePanel {
  private readonly panel: SnapshotPanel;
  constructor(pi: ExtensionAPI) {
    this.panel = new SnapshotPanel(pi, "schedule", "schedules · snapshot");
  }
  async open(ctx: ExtensionCommandContext, tasks: readonly ScheduledTask[], writable: boolean, error?: string): Promise<void> {
    return this.panel.open(ctx, scheduleBlocks(tasks, writable, error), Boolean(error));
  }
}
