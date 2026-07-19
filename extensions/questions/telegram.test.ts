import { expect, test } from "bun:test";
import type { TelegramPromptHandle, TelegramPromptRequest, TelegramService } from "../telegram/service.ts";
import { normalizeQuestions } from "./model.ts";
import { createTelegramQuestionReply, formatTelegramQuestion } from "./telegram.ts";

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

test("uses redacted callback display text for secret choices", async () => {
  const service = fakeService<string>(async (request) => {
    expect(request.choices).toEqual([{
      label: "Use production token",
      value: "Use production token",
      displayText: "[secret provided]",
    }]);
    return {
      messageId: 1,
      result: Promise.resolve({ status: "answered", value: request.choices![0]!.value }),
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
  expect(await reply.source.run(new AbortController().signal)).toEqual({
    status: "answered",
    answer: "Use production token",
  });
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
  await Promise.resolve();
  await reply.mirror({ status: "answered", answer: "actual-secret", source: "terminal" });
  const cancelled = createTelegramQuestionReply(service, question, 0, 1);
  void cancelled.source.run(new AbortController().signal);
  await Promise.resolve();
  await cancelled.mirror({ status: "cancelled", source: "terminal" });

  expect(mirrors).toEqual([
    { status: "answered", source: "terminal", displayText: "[secret provided]" },
    { status: "cancelled", source: "terminal" },
  ]);
  expect(JSON.stringify(mirrors)).not.toContain("actual-secret");
});

test("formats bounded freeform and secret Telegram guidance", () => {
  const [question] = normalizeQuestions([{
    id: "token",
    question: "Provide the token",
    secret: true,
  }]);
  const message = formatTelegramQuestion(question, 1, 3);
  expect(message).toContain("Question 2/3");
  expect(message).toContain("your own answer");
  expect(message).toContain("Telegram still retains them");

  const [longQuestion] = normalizeQuestions([{
    id: "long",
    question: "q".repeat(2_000),
    options: Array.from({ length: 8 }, (_, index) => `${index}-${"x".repeat(295)}`),
  }]);
  const bounded = formatTelegramQuestion(longQuestion, 0, 1);
  expect(bounded.length).toBeLessThanOrEqual(3_900);
  expect(bounded).toContain("Choose a button below");
  expect(bounded).toContain("Send /cancel");
});
