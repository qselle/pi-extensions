import { safeTelegramError } from "../telegram/api.ts";
import type { TelegramPromptHandle, TelegramService } from "../telegram/service.ts";
import type { Question } from "./model.ts";
import { parseReplyText } from "./model.ts";
import type { ReplyOutcome, ReplySource, SourceReply } from "./race.ts";

const TELEGRAM_QUESTION_LIMIT = 3_900;

export interface TelegramQuestionReply {
  source: ReplySource;
  mirror(outcome: ReplyOutcome): Promise<void>;
}

export function createTelegramQuestionReply(
  service: TelegramService,
  question: Question,
  index: number,
  total: number,
): TelegramQuestionReply {
  let handle: TelegramPromptHandle<string> | undefined;
  const source: ReplySource = {
    name: "telegram",
    run: async (signal): Promise<SourceReply> => {
      const opened = await service.openPrompt<string>({
        text: formatTelegramQuestion(question, index, total),
        inputPlaceholder: question.secret ? "Reply with the secret answer" : "Reply with a number or your answer",
        choices: question.options.map((option) => ({
          label: option,
          value: option,
          displayText: question.secret ? "[secret provided]" : option,
        })),
        parse: (text) => {
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
            displayText: question.secret ? "[secret provided]" : parsed,
          };
        },
      }, signal);
      handle = opened;
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

export function formatTelegramQuestion(question: Question, index: number, total: number): string {
  const lines = [
    `❓ Pi needs input · Question ${index + 1}/${total}`,
    "",
    clip(question.question, 1_600),
  ];
  if (question.options.length > 0) {
    lines.push("", ...question.options.map((option, optionIndex) => `${optionIndex + 1}. ${clip(option, 180)}`));
  }
  lines.push(
    "",
    question.options.length === 0
      ? "Reply to this message with your own answer."
      : question.allowOther
        ? "Choose a button below, or reply to this message with your own answer."
        : "Choose a button below. Direct replies with an option number or exact option also work.",
    "Send /cancel to cancel. The first reply between Telegram and the terminal wins.",
  );
  if (question.secret) lines.push("⚠️ Secret replies are not stored in Pi, but Telegram still retains them.");
  return clip(lines.join("\n"), TELEGRAM_QUESTION_LIMIT);
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}
