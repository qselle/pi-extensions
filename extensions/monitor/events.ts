export const MONITOR_ALERT_EVENT = "monitor:alert";

/** Deliberately excludes commands, output, and provider error text. */
interface MonitorAlertBase {
  readonly version: 1;
  readonly alertId: string;
  readonly sessionId: string;
  readonly monitorId: string;
  readonly condition: "change" | "failure" | "success" | "always";
  readonly runs: number;
  readonly maxRuns: number;
}

export interface MonitorResultAlertEvent extends MonitorAlertBase {
  readonly kind: "result" | "wakeup_failed" | "agent_failed";
  readonly exitCode: number;
  readonly killed: boolean;
}

export interface MonitorExpiredEvent extends MonitorAlertBase {
  readonly kind: "expired";
  readonly reason: "run_limit" | "time_limit";
}

export type MonitorAlertEvent = MonitorResultAlertEvent | MonitorExpiredEvent;

export function isMonitorAlertEvent(value: unknown): value is MonitorAlertEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<MonitorAlertEvent>;
  return event.version === 1
    && typeof event.alertId === "string" && event.alertId.length > 0 && event.alertId.length <= 200
    && typeof event.sessionId === "string" && /^[\w-]{1,100}$/u.test(event.sessionId)
    && typeof event.monitorId === "string" && /^[\w-]{1,100}$/u.test(event.monitorId)
    && ["change", "failure", "success", "always"].includes(event.condition ?? "")
    && Number.isSafeInteger(event.runs) && event.runs! >= 0
    && Number.isSafeInteger(event.maxRuns) && event.maxRuns! >= 1 && event.maxRuns! >= event.runs!
    && (event.kind === "expired"
      ? event.reason === "run_limit" || event.reason === "time_limit"
      : (event.kind === "result" || event.kind === "wakeup_failed" || event.kind === "agent_failed")
        && event.runs! >= 1 && Number.isSafeInteger(event.exitCode) && typeof event.killed === "boolean");
}
