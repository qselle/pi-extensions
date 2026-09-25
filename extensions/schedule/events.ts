export const SCHEDULE_ATTENTION_EVENT = "schedule:attention";

/** No scheduled prompts, filesystem paths, or underlying error text. */
export interface ScheduleAttentionEvent {
  readonly version: 1;
  readonly attentionId: string;
  readonly sessionId: string;
  readonly kind: "queue_failed" | "wakeup_failed" | "agent_failed" | "delivery_unconfirmed";
  readonly taskId?: string;
  readonly taskKind?: "reminder" | "cron";
}

export function isScheduleAttentionEvent(value: unknown): value is ScheduleAttentionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ScheduleAttentionEvent>;
  return event.version === 1
    && [event.attentionId, event.sessionId].every((id) => typeof id === "string" && /^[\w:-]{1,200}$/u.test(id))
    && ["queue_failed", "wakeup_failed", "agent_failed", "delivery_unconfirmed"].includes(event.kind ?? "")
    && (event.taskId === undefined
      ? event.taskKind === undefined
      : typeof event.taskId === "string" && /^[\w-]{1,100}$/u.test(event.taskId)
        && (event.taskKind === "reminder" || event.taskKind === "cron"));
}
