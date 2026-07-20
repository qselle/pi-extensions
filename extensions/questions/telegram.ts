import { safeTelegramError } from "../telegram/api.ts";
import type {
  TelegramPromptHandle,
  TelegramPromptResolution,
  TelegramService,
} from "../telegram/service.ts";
import type { Question } from "./model.ts";
import { parseReplyText } from "./model.ts";
import type { ReplyOutcome, ReplySource, SourceReply } from "./race.ts";

const TELEGRAM_QUESTION_LIMIT = 3_900;

export interface TelegramQuestionReply {
  source: ReplySource;
  mirror(outcome: ReplyOutcome): Promise<void>;
}

export interface TelegramQuestionOptions {
  contextLabel?: string;
  delayMs?: number;
  onOpened?(): void;
}

export function createTelegramQuestionReply(
  service: TelegramService,
  question: Question,
  index: number,
  total: number,
  options: TelegramQuestionOptions = {},
): TelegramQuestionReply {
  let handle: TelegramPromptHandle<string> | undefined;
  const contextLabel = options.contextLabel?.trim() || "Pi";
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const source: ReplySource = {
    name: "telegram",
    run: async (signal): Promise<SourceReply> => {
      await waitForDelay(delayMs, signal);
      const opened = await service.openPrompt<string>({
        text: formatTelegramQuestion(question, index, total, contextLabel, delayMs),
        inputPlaceholder: "Reply with a number or your answer",
        choices: question.secret
          ? []
          : question.options.map((option) => ({
              label: option,
              value: option,
              displayText: option,
            })),
        parseMode: "HTML",
        interactive: !question.secret,
        formatResolved: (resolution) => formatResolvedTelegramQuestion(
          question,
          index,
          total,
          contextLabel,
          resolution,
        ),
        parse: (text) => {
          if (question.secret) {
            return { status: "rejected", message: "Secret questions must be answered in Pi." };
          }
          const parsed = parseReplyText(question, text);
          if (parsed === "cancel") return { status: "cancelled" };
          if (parsed === undefined) {
            return {
              status: "rejected",
              message: "Please reply with one of the listed option numbers, or send /cancel.",
            };
          }
          return {
            status: "accepted",
            value: parsed,
            displayText: parsed,
          };
        },
      }, signal);
      handle = opened;
      options.onOpened?.();
      const result = await opened.result;
      if (result.status === "answered") return { status: "answered", answer: result.value };
      return result.status === "cancelled" ? { status: "cancelled" } : { status: "unavailable" };
    },
  };

  return {
    source,
    async mirror(outcome) {
      if (!handle || outcome.status === "unavailable" || outcome.source !== "terminal") return;
      if (outcome.status === "answered") {
        await handle.close({
          status: "answered",
          source: "terminal",
          displayText: question.secret ? "[secret provided]" : outcome.answer,
        });
      } else if (outcome.status === "cancelled") {
        await handle.close({ status: "cancelled", source: "terminal" });
      }
    },
  };
}

export function safeTelegramQuestionError(error: unknown): string {
  const message = safeTelegramError(error);
  return message === "Telegram request failed unexpectedly."
    ? "Telegram question delivery failed unexpectedly; the terminal remains available."
    : `${message} The terminal remains available.`;
}

export function formatTelegramQuestion(
  question: Question,
  index: number,
  total: number,
  contextLabel = "Pi",
  delayMs = 0,
): string {
  const context = `<b>${escapeTelegramHtml(preview(contextLabel, 100))}</b> · Question ${index + 1} of ${total}`;
  if (question.secret) {
    const lines = [
      "🔐 <b>Secret input needed</b>",
      context,
      "",
      "A secret response is waiting in Pi.",
      "For your security, answer in the terminal.",
    ];
    if (delayMs > 0) lines.push("", `⏱ The agent has been waiting ${formatDelay(delayMs)} for your response.`);
    return clip(lines.join("\n"), TELEGRAM_QUESTION_LIMIT);
  }

  const instruction = question.options.length === 0
    ? "↩️ Reply to this message with your answer."
    : question.allowOther
      ? "Choose below, or reply to this message."
      : "Choose an answer below.";
  const lines = [
    "❓ <b>Input needed</b>",
    context,
    "",
    `<blockquote>${escapeTelegramHtml(preview(question.question, 1_600))}</blockquote>`,
  ];
  if (delayMs > 0) lines.push(`⏱ The agent has been waiting ${formatDelay(delayMs)} for your response.`);
  lines.push("", instruction, "Send /cancel to cancel. The first reply between Telegram and the terminal wins.");
  return clip(lines.join("\n"), TELEGRAM_QUESTION_LIMIT);
}

export function formatResolvedTelegramQuestion(
  question: Question,
  index: number,
  total: number,
  contextLabel: string,
  resolution: TelegramPromptResolution,
): string {
  const heading = resolution.status === "cancelled"
    ? resolution.source === "terminal"
      ? "⚪ <b>Question cancelled in Pi</b>"
      : "⚪ <b>Question cancelled from Telegram</b>"
    : question.secret
      ? "✅ <b>Answered securely in Pi</b>"
      : resolution.source === "telegram"
        ? "✅ <b>Answered in Telegram</b>"
        : "✅ <b>Answered in Pi</b>";
  const lines = [
    heading,
    `<b>${escapeTelegramHtml(preview(contextLabel, 100))}</b> · Question ${index + 1} of ${total}`,
  ];
  if (!question.secret) {
    lines.push("", `<blockquote>${escapeTelegramHtml(preview(question.question, 1_600))}</blockquote>`);
    if (resolution.status === "answered" && resolution.source === "telegram") {
      lines.push(`<b>Answer</b>  ${escapeTelegramHtml(preview(resolution.displayText, 1_200))}`);
    } else if (resolution.status === "cancelled") {
      lines.push("No answer was submitted.");
    }
  }
  return clip(lines.join("\n"), TELEGRAM_QUESTION_LIMIT);
}

export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function preview(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length <= limit
    ? normalized
    : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function formatDelay(delayMs: number): string {
  const seconds = Math.max(1, Math.round(delayMs / 1_000));
  if (delayMs < 60_000) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = delayMs / 60_000;
  const value = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
  return `${value} minute${minutes === 1 ? "" : "s"}`;
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}
