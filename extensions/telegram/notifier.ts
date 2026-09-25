import { isGoalAttentionEvent, isGoalCompletedEvent, type GoalCompletedEvent } from "../goal/events.ts";
import { isScheduleAttentionEvent } from "../schedule/events.ts";
import type { TelegramGoalDetails } from "./config.ts";
import { formatGoalAttentionMessage, formatGoalCompletionMessage, formatMonitorAlertMessage, formatScheduleAttentionMessage } from "./message.ts";
import { safeTelegramError, type TelegramSendResult } from "./api.ts";
import type { TelegramService } from "./service.ts";
import { isMonitorAlertEvent } from "../monitor/events.ts";

const MAX_SEEN_ALERTS = 1_000;

export interface TelegramNotifierHooks {
  onFailure?(message: string): void;
}

export class TelegramNotifier {
  private readonly seen = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly service: TelegramService,
    private readonly details: TelegramGoalDetails,
    private readonly hooks: TelegramNotifierHooks = {},
  ) {}

  handle(value: unknown): boolean {
    if (!isGoalCompletedEvent(value)) return false;
    const event = value as GoalCompletedEvent;
    if (this.seen.has(event.completionId)) return false;
    this.remember(event.completionId);
    const text = formatGoalCompletionMessage(event, this.details);
    void this.track(this.service.send(text)).catch((error) => {
      this.hooks.onFailure?.(safeTelegramError(error));
    });
    return true;
  }

  handleMonitor(value: unknown): boolean {
    if (!isMonitorAlertEvent(value)) return false;
    return this.notifyOnce(`monitor:${value.sessionId}:${value.alertId}`, formatMonitorAlertMessage(value));
  }

  handleGoalAttention(value: unknown): boolean {
    if (!isGoalAttentionEvent(value)) return false;
    return this.notifyOnce(`goal:${value.sessionId}:${value.attentionId}`, formatGoalAttentionMessage(value));
  }

  handleSchedule(value: unknown): boolean {
    if (!isScheduleAttentionEvent(value)) return false;
    return this.notifyOnce(`schedule:${value.sessionId}:${value.attentionId}`, formatScheduleAttentionMessage(value));
  }

  private notifyOnce(key: string, text: string): boolean {
    if (this.seen.has(key)) return false;
    this.remember(key);
    void this.track(this.service.send(text)).catch((error) => {
      this.hooks.onFailure?.(safeTelegramError(error));
    });
    return true;
  }

  sendTest(): Promise<TelegramSendResult> {
    return this.track(this.service.send(
      "🧪 Pi Telegram integration test\n\nConfiguration and the shared Telegram service are working.",
    ));
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private remember(completionId: string): void {
    this.seen.add(completionId);
    if (this.seen.size <= MAX_SEEN_ALERTS) return;
    const oldest = this.seen.values().next().value;
    if (oldest) this.seen.delete(oldest);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = promise.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }
}
