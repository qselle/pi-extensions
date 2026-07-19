interface SharedEntry<T> {
  key: string;
  controller: AbortController;
  promise: Promise<T>;
  consumers: number;
  settled: boolean;
}

/** Share expensive work by key while keeping each caller independently cancellable. */
export class SharedWork<T> {
  private entry?: SharedEntry<T>;

  acquire(key: string, signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.entry || this.entry.key !== key) {
      const controller = new AbortController();
      const entry: SharedEntry<T> = {
        key,
        controller,
        consumers: 0,
        settled: false,
        promise: Promise.resolve(undefined as T),
      };
      entry.promise = start(controller.signal).then(
        (value) => {
          entry.settled = true;
          return value;
        },
        (error) => {
          entry.settled = true;
          if (this.entry === entry) this.entry = undefined;
          throw error;
        },
      );
      this.entry = entry;
    }

    const entry = this.entry;
    entry.consumers += 1;
    return cancellable(entry.promise, signal).finally(() => {
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (!entry.settled && entry.consumers === 0) {
        entry.controller.abort();
        if (this.entry === entry) this.entry = undefined;
      }
    });
  }

  clear(): void {
    const entry = this.entry;
    this.entry = undefined;
    if (entry && !entry.settled) entry.controller.abort();
  }
}

function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Operation aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
