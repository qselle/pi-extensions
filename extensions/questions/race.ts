export type ReplySourceName = "terminal" | "telegram";

export type SourceReply =
  | { status: "answered"; answer: string }
  | { status: "cancelled" }
  | { status: "unavailable" };

export type ReplyOutcome =
  | { status: "answered"; answer: string; source: ReplySourceName }
  | { status: "cancelled"; source?: ReplySourceName }
  | { status: "unavailable" };

export interface ReplySource {
  name: ReplySourceName;
  run(signal: AbortSignal): Promise<SourceReply>;
}

export interface ReplyRaceOptions {
  signal?: AbortSignal;
  onSourceError?(source: ReplySourceName, error: unknown): void;
}

export async function firstReplyWins(
  sources: ReplySource[],
  options: ReplyRaceOptions = {},
): Promise<ReplyOutcome> {
  if (options.signal?.aborted) return { status: "cancelled" };
  if (sources.length === 0) return { status: "unavailable" };

  const controller = new AbortController();
  let settled = false;
  let pending = sources.length;
  let resolveOutcome!: (outcome: ReplyOutcome) => void;
  const outcome = new Promise<ReplyOutcome>((resolve) => { resolveOutcome = resolve; });

  const finish = (value: ReplyOutcome) => {
    if (settled) return;
    settled = true;
    controller.abort();
    resolveOutcome(value);
  };
  const unavailable = () => {
    pending -= 1;
    if (pending === 0) finish({ status: "unavailable" });
  };
  const abort = () => finish({ status: "cancelled" });
  options.signal?.addEventListener("abort", abort, { once: true });

  for (const source of sources) {
    let running: Promise<SourceReply>;
    try {
      running = source.run(controller.signal);
    } catch (error) {
      options.onSourceError?.(source.name, error);
      unavailable();
      continue;
    }
    void running.then((reply) => {
        if (settled) return;
        if (reply.status === "answered") {
          finish({ status: "answered", answer: reply.answer, source: source.name });
        } else if (reply.status === "cancelled") {
          finish({ status: "cancelled", source: source.name });
        } else {
          unavailable();
        }
      })
      .catch((error) => {
        if (settled || controller.signal.aborted) return;
        options.onSourceError?.(source.name, error);
        unavailable();
      });
  }

  try {
    return await outcome;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
