import { expect, test } from "bun:test";
import { registerTelegramService, type TelegramPromptHandle, type TelegramService } from "../telegram/service.ts";
import questionsExtension from "./index.ts";

class MockPi {
  tool: any;
  sessionName?: string;
  emitted: Array<{ name: string; payload: unknown }> = [];

  events = {
    emit: (name: string, payload: unknown) => { this.emitted.push({ name, payload }); },
  };

  registerTool(tool: any) { this.tool = tool; }
  getSessionName() { return this.sessionName; }
  on() {}
}

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
};

const keybindings = {
  matches(data: string, id: string) {
    return (id === "tui.select.confirm" && data === "\r")
      || (id === "tui.select.cancel" && data === "escape")
      || (id === "tui.select.up" && data === "up")
      || (id === "tui.select.down" && data === "down");
  },
};

function serviceWithPrompt<T>(
  open: (request: any, signal?: AbortSignal) => Promise<TelegramPromptHandle<T>>,
): TelegramService {
  return {
    send: async () => ({}),
    openPrompt: open as TelegramService["openPrompt"],
    drain: async () => undefined,
    shutdown: async () => undefined,
  };
}

function terminalContext(titles: string[]) {
  return {
    mode: "tui",
    ui: {
      theme,
      setTitle: (title: string) => titles.push(title),
      notify: () => undefined,
      custom: (factory: any) => new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          theme,
          keybindings,
          resolve,
        );
        queueMicrotask(() => component.handleInput("\r"));
      }),
    },
  } as any;
}

test("collects a terminal answer first, cancels Telegram polling, and mirrors the answer", async () => {
  const pi = new MockPi();
  let telegramAborted = false;
  let mirrored: unknown;
  const telegram = serviceWithPrompt<string>(async (_request, signal) => {
    let resolve!: (value: any) => void;
    const result = new Promise<any>((done) => { resolve = done; });
    signal?.addEventListener("abort", () => {
      telegramAborted = true;
      resolve({ status: "unavailable" });
    }, { once: true });
    return {
      messageId: 1,
      result,
      close: async (outcome) => { mirrored = outcome; },
    };
  });
  questionsExtension(pi as any, { telegramService: telegram });
  const titles: string[] = [];

  const result = await pi.tool.execute("call", {
    questions: [{ id: "color", question: "Pick a color", options: ["Blue", "Green"] }],
  }, new AbortController().signal, undefined, terminalContext(titles));
  await Promise.resolve();

  expect(result.content[0].text).toBe("color: Blue");
  expect(result.details.answers).toEqual([{
    id: "color",
    question: "Pick a color",
    answer: "Blue",
    source: "terminal",
  }]);
  expect(telegramAborted).toBe(true);
  expect(mirrored).toEqual({ status: "answered", source: "terminal", displayText: "Blue" });
  expect(titles).toEqual(["❓ Input needed · Question 1/1", "pi"]);
  expect(pi.emitted).toEqual([
    { name: "terminal-title:override", payload: { source: "questions", title: "❓ Input needed · Question 1/1" } },
    { name: "terminal-title:override", payload: { source: "questions", title: undefined } },
  ]);
});

test("a Telegram reply closes the terminal prompt", async () => {
  const pi = new MockPi();
  let terminalClosed = false;
  const telegram = serviceWithPrompt<string>(async () => ({
    messageId: 1,
    result: Promise.resolve({ status: "answered", value: "Remote answer" }),
    close: async () => undefined,
  }));
  questionsExtension(pi as any, { telegramService: telegram });
  const ctx = {
    mode: "tui",
    cwd: "/work/project",
    ui: {
      theme,
      setTitle: () => undefined,
      notify: () => undefined,
      custom: (factory: any) => new Promise((resolve) => {
        factory(
          { requestRender: () => undefined },
          theme,
          keybindings,
          (value: unknown) => {
            terminalClosed = true;
            resolve(value);
          },
        );
      }),
    },
  } as any;

  const result = await pi.tool.execute("call", {
    questions: [{ id: "destination", question: "Deploy where?" }],
  }, new AbortController().signal, undefined, ctx);

  expect(terminalClosed).toBe(true);
  expect(result.content[0].text).toBe("destination: Remote answer [via Telegram]");
  expect(result.details.answers).toEqual([{
    id: "destination",
    question: "Deploy where?",
    answer: "Remote answer",
    source: "telegram",
  }]);
});

test("discovers the optional globally registered Telegram hub at execution time", async () => {
  const pi = new MockPi();
  const telegram = serviceWithPrompt<string>(async () => ({
    messageId: 1,
    result: Promise.resolve({ status: "answered", value: "Remote answer" }),
    close: async () => undefined,
  }));
  const registration = registerTelegramService(telegram);
  try {
    questionsExtension(pi as any);
    const result = await pi.tool.execute("call", {
      questions: [{ id: "remote", question: "Answer remotely?" }],
    }, new AbortController().signal, undefined, {
      mode: "json",
      ui: { notify: () => undefined },
    });
    expect(result.content[0].text).toBe("remote: Remote answer [via Telegram]");
  } finally {
    registration.unregister();
  }
});

test("labels delayed first cards with the session and sends follow-up questions immediately", async () => {
  const pi = new MockPi();
  pi.sessionName = "Release <v2>";
  const requests: any[] = [];
  const telegram = {
    ...serviceWithPrompt<string>(async (request) => {
      requests.push(request);
      return {
        messageId: requests.length,
        result: Promise.resolve({ status: "answered", value: `answer-${requests.length}` }),
        close: async () => undefined,
      };
    }),
    questionDelayMs: 1,
  } satisfies TelegramService;
  questionsExtension(pi as any, { telegramService: telegram });

  const result = await pi.tool.execute("call", {
    questions: [
      { id: "first", question: "First?" },
      { id: "second", question: "Second?" },
    ],
  }, new AbortController().signal, undefined, {
    mode: "json",
    cwd: "/work/project",
    ui: { notify: () => undefined },
  });

  expect(result.content[0].text).toContain("first: answer-1 [via Telegram]");
  expect(requests).toHaveLength(2);
  expect(requests[0].text).toContain("Release &lt;v2&gt;");
  expect(requests[0].text).toContain("has been waiting 1 second");
  expect(requests[1].text).not.toContain("has been waiting");
});

test("requires TUI for secret questions even when Telegram is configured", async () => {
  const pi = new MockPi();
  let passive = false;
  const telegram = serviceWithPrompt<string>(async (request) => {
    passive = request.interactive === false;
    return {
      messageId: 1,
      result: Promise.resolve({ status: "unavailable" }),
      close: async () => undefined,
    };
  });
  questionsExtension(pi as any, { telegramService: telegram });

  const result = await pi.tool.execute("call", {
    questions: [{ id: "token", question: "Token?", secret: true }],
  }, new AbortController().signal, undefined, {
    mode: "json",
    cwd: "/work/project",
    ui: { notify: () => undefined },
  });

  expect(passive).toBe(true);
  expect(result.content[0].text).toContain("Secret questions require Pi in TUI mode");
  expect(result.details.interrupted).toBe(true);
});

test("reports a useful interruption when neither terminal nor Telegram is available", async () => {
  const pi = new MockPi();
  questionsExtension(pi as any, { telegramService: null });
  const result = await pi.tool.execute("call", {
    questions: [{ id: "choice", question: "Choose?", options: ["A", "B"] }],
  }, new AbortController().signal, undefined, {
    mode: "json",
    ui: { notify: () => undefined },
  });

  expect(result.content[0].text).toContain("No reply channel is available");
  expect(result.details.interrupted).toBe(true);
});
