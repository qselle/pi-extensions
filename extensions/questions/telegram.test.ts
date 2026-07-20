import { expect, test } from "bun:test";
import type { TelegramPromptHandle, TelegramPromptRequest, TelegramService } from "../telegram/service.ts";
import { normalizeQuestions } from "./model.ts";
import {
  createTelegramQuestionReply,
  formatResolvedTelegramQuestion,
  formatTelegramQuestion,
} from "./telegram.ts";

function fakeService<T>(
  open: (request: TelegramPromptRequest<T>, signal?: AbortSignal) => Promise<TelegramPromptHandle<T>>,
): TelegramService {
  return {
    send: async () => ({}),
    openPrompt: open as TelegramService["openPrompt"],
    drain: async () => undefined,
    shutdown: async () => undefined,
  };
}

test("adapts option and freeform parsing to the central Telegram prompt service", async () => {
  const parsed: unknown[] = [];
  const service = fakeService<string>(async (request) => {
    expect(request.choices).toEqual([
      { label: "Red", value: "Red", displayText: "Red" },
      { label: "Blue", value: "Blue", displayText: "Blue" },
    ]);
    parsed.push(request.parse("2"));
    parsed.push(request.parse("custom answer"));
    const accepted = request.parse("2");
    if (accepted.status !== "accepted") throw new Error("expected accepted option");
    return {
      messageId: 1,
      result: Promise.resolve({ status: "answered", value: accepted.value }),
      close: async () => undefined,
    };
  });
  const [question] = normalizeQuestions([{ id: "color", question: "Pick a color", options: ["Red", "Blue"] }]);

  const reply = createTelegramQuestionReply(service, question, 0, 1);
  expect(await reply.source.run(new AbortController().signal)).toEqual({ status: "answered", answer: "Blue" });
  expect(parsed).toEqual([
    { status: "accepted", value: "Blue", displayText: "Blue" },
    { status: "accepted", value: "custom answer", displayText: "custom answer" },
  ]);
});

test("rejects unlisted replies when freeform is disabled", async () => {
  const service = fakeService<string>(async (request) => {
    expect(request.parse("Maybe")).toEqual({
      status: "rejected",
      message: "Please reply with one of the listed option numbers, or send /cancel.",
    });
    expect(request.parse("/cancel")).toEqual({ status: "cancelled" });
    return {
      messageId: 1,
      result: Promise.resolve({ status: "cancelled" }),
      close: async () => undefined,
    };
  });
  const [question] = normalizeQuestions([{
    id: "confirm",
    question: "Continue?",
    options: ["Yes", "No"],
    allow_other: false,
  }]);

  const reply = createTelegramQuestionReply(service, question, 0, 1);
  expect(await reply.source.run(new AbortController().signal)).toEqual({ status: "cancelled" });
});

test("sends only a passive redacted alert for secret questions", async () => {
  const service = fakeService<string>(async (request) => {
    expect(request.interactive).toBe(false);
    expect(request.choices).toEqual([]);
    expect(request.text).not.toContain("Which token?");
    expect(request.text).not.toContain("Use production token");
    expect(request.text).toContain("answer in the terminal");
    return {
      messageId: 1,
      result: Promise.resolve({ status: "unavailable" }),
      close: async () => undefined,
    };
  });
  const [question] = normalizeQuestions([{
    id: "token",
    question: "Which token?",
    options: ["Use production token"],
    allow_other: false,
    secret: true,
  }]);

  const reply = createTelegramQuestionReply(service, question, 0, 1);
  expect(await reply.source.run(new AbortController().signal)).toEqual({ status: "unavailable" });
});

test("mirrors terminal answers through the prompt handle and masks secrets", async () => {
  const mirrors: unknown[] = [];
  const service = fakeService<string>(async () => ({
    messageId: 1,
    result: new Promise(() => undefined),
    close: async (outcome) => { mirrors.push(outcome); },
  }));
  const [question] = normalizeQuestions([{ id: "token", question: "Token?", secret: true }]);
  const reply = createTelegramQuestionReply(service, question, 0, 1);
  void reply.source.run(new AbortController().signal);
  await Bun.sleep(0);
  await reply.mirror({ status: "answered", answer: "actual-secret", source: "terminal" });
  const cancelled = createTelegramQuestionReply(service, question, 0, 1);
  void cancelled.source.run(new AbortController().signal);
  await Bun.sleep(0);
  await cancelled.mirror({ status: "cancelled", source: "terminal" });

  expect(mirrors).toEqual([
    { status: "answered", source: "terminal", displayText: "[secret provided]" },
    { status: "cancelled", source: "terminal" },
  ]);
  expect(JSON.stringify(mirrors)).not.toContain("actual-secret");
});

test("finalizes a card when terminal input wins while Telegram is still sending it", async () => {
  const mirrors: unknown[] = [];
  let finishOpen!: () => void;
  let finishResult!: (result: { status: "unavailable" }) => void;
  const service = fakeService<string>(() => new Promise((resolve) => {
    finishOpen = () => {
      const result = new Promise<{ status: "unavailable" }>((done) => { finishResult = done; });
      resolve({
        messageId: 9,
        result,
        close: async (outcome) => {
          mirrors.push(outcome);
          finishResult({ status: "unavailable" });
        },
      });
    };
  }));
  const [question] = normalizeQuestions([{ id: "race", question: "Ship now?" }]);
  const reply = createTelegramQuestionReply(service, question, 0, 1);
  const controller = new AbortController();
  const running = reply.source.run(controller.signal);
  await Bun.sleep(0);

  controller.abort();
  const mirrored = reply.mirror({ status: "answered", answer: "Yes", source: "terminal" });
  finishOpen();

  await mirrored;
  expect(await running).toEqual({ status: "unavailable" });
  expect(mirrors).toEqual([{
    status: "answered",
    source: "terminal",
    displayText: "Yes",
  }]);
});

test("formats bounded HTML cards, context, delay copy, and redacted secrets", () => {
  const [secret] = normalizeQuestions([{
    id: "token",
    question: "Provide <the> & token",
    secret: true,
  }]);
  const secretMessage = formatTelegramQuestion(secret, 1, 3, "Release <v2>", 90_000);
  expect(secretMessage).toContain("Question 2 of 3");
  expect(secretMessage).toContain("Release &lt;v2&gt;");
  expect(secretMessage).toContain("1.5 minutes");
  expect(secretMessage).not.toContain("Provide");

  const [longQuestion] = normalizeQuestions([{
    id: "long",
    question: `<plan> & ${"q".repeat(1_900)}`,
    options: Array.from({ length: 8 }, (_, index) => `${index}-${"x".repeat(295)}`),
  }]);
  const bounded = formatTelegramQuestion(longQuestion, 0, 1, "workspace");
  expect(bounded.length).toBeLessThanOrEqual(3_900);
  expect(bounded).toContain("&lt;plan&gt; &amp;");
  expect(bounded).toContain("Choose below, or reply to this message");
  expect(bounded).toContain("Send /cancel");

  const resolved = formatResolvedTelegramQuestion(longQuestion, 0, 1, "workspace", {
    status: "answered",
    source: "telegram",
    displayText: "Ship <now>",
  });
  expect(resolved).toContain("Answered in Telegram");
  expect(resolved).toContain("Ship &lt;now&gt;");
  expect(formatResolvedTelegramQuestion(longQuestion, 0, 1, "workspace", { status: "closed" }))
    .toContain("Question closed");
});

test("does not open Telegram when the terminal wins during the configured delay", async () => {
  let opened = false;
  const service = fakeService<string>(async () => {
    opened = true;
    throw new Error("should not open");
  });
  const [question] = normalizeQuestions([{ id: "wait", question: "Wait?" }]);
  const reply = createTelegramQuestionReply(service, question, 0, 1, { delayMs: 60_000 });
  const controller = new AbortController();
  const result = reply.source.run(controller.signal).catch((error) => error as Error);
  controller.abort();
  expect((await result).name).toBe("AbortError");
  expect(opened).toBe(false);
});
