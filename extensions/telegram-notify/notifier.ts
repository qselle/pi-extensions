import { isGoalCompletedEvent, type GoalCompletedEvent } from "../goal/events.ts";
import type { TelegramConfig } from "./config.ts";
import { formatGoalCompletionMessage } from "./message.ts";
import { TelegramDeliveryError, sendTelegramMessage, type TelegramSendResult, type TelegramTransportOptions } from "./telegram.ts";

const MAX_SEEN_COMPLETIONS = 1_000;

export interface TelegramNotifierHooks {
  onFailure?(message: string): void;
}

export class TelegramNotifier {
  private readonly seen = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly config: TelegramConfig,
    private readonly transportOptions: TelegramTransportOptions = {},
    private readonly hooks: TelegramNotifierHooks = {},
  ) {}

  handle(value: unknown): boolean {
    if (!isGoalCompletedEvent(value)) return false;
    const event = value as GoalCompletedEvent;
    if (this.seen.has(event.completionId)) return false;
    this.remember(event.completionId);
    const text = formatGoalCompletionMessage(event, this.config.details);
    void this.track(sendTelegramMessage(this.config, text, this.transportOptions)).catch((error) => {
      this.hooks.onFailure?.(safeDeliveryError(error));
    });
    return true;
  }

  sendTest(): Promise<TelegramSendResult> {
    return this.track(sendTelegramMessage(
      this.config,
      "🧪 Pi Telegram notification test\n\nConfiguration is working.",
      this.transportOptions,
    ));
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private remember(completionId: string): void {
    this.seen.add(completionId);
    if (this.seen.size <= MAX_SEEN_COMPLETIONS) return;
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

export function safeDeliveryError(error: unknown): string {
  return error instanceof TelegramDeliveryError
    ? error.message
    : "Telegram notification failed unexpectedly.";
}
