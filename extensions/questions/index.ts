import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getTelegramService, type TelegramService } from "../telegram/service.ts";
import {
  MAX_ID_CHARS,
  MAX_OPTION_CHARS,
  MAX_OPTIONS,
  MAX_QUESTION_CHARS,
  MAX_QUESTIONS,
  normalizeQuestions,
  publicQuestions,
  type QuestionAnswer,
  type QuestionnaireDetails,
} from "./model.ts";
import { firstReplyWins } from "./race.ts";
import { createTelegramQuestionReply, safeTelegramQuestionError } from "./telegram.ts";
import { createTerminalReplySource } from "./ui.ts";

const TERMINAL_TITLE_EVENT = "terminal-title:override";

const parameters = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: MAX_ID_CHARS, description: "Stable short identifier" },
          question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_CHARS },
          options: {
            type: "array",
            maxItems: MAX_OPTIONS,
            items: { type: "string", minLength: 1, maxLength: MAX_OPTION_CHARS },
            description: "Optional choices. A freeform Other choice is appended by default.",
          },
          allow_other: { type: "boolean", description: "Allow a final freeform Other choice (default true)" },
          secret: { type: "boolean", description: "Mask locally and omit the answer from Pi's transcript" },
        },
        required: ["id", "question"],
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as any;

export interface QuestionsExtensionOptions {
  telegramService?: TelegramService | null;
  isSubagentChild?: boolean;
}

function hasAnswer(answer: QuestionAnswer | undefined): boolean {
  return Boolean(answer && (answer.answer !== undefined || answer.provided));
}

function setAttentionTitle(pi: ExtensionAPI, ctx: ExtensionContext, index: number, total: number): void {
  if (ctx.mode !== "tui") return;
  const title = `❓ Input needed · Question ${index + 1}/${total}`;
  ctx.ui.setTitle(title);
  pi.events.emit(TERMINAL_TITLE_EVENT, { source: "questions", title });
}

function clearAttentionTitle(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setTitle("pi");
  pi.events.emit(TERMINAL_TITLE_EVENT, { source: "questions", title: undefined });
}

function recap(details: QuestionnaireDetails, theme: any): string {
  const answered = details.answers.filter(hasAnswer).length;
  const lines = [
    `${theme.fg("accent", "◆")} ${theme.bold("Questions")} ${answered}/${details.questions.length} answered${details.interrupted ? theme.fg("warning", " · interrupted") : ""}`,
  ];
  for (const question of details.questions) {
    const answer = details.answers.find((candidate) => candidate.id === question.id);
    const source = answer?.source === "telegram" ? theme.fg("muted", " · Telegram") : "";
    lines.push(`  ${hasAnswer(answer) ? theme.fg("success", "✓") : theme.fg("warning", "○")} ${question.question}${source}`);
    if (hasAnswer(answer)) {
      lines.push(`    ${theme.fg("dim", "answer:")} ${theme.fg("accent", question.secret ? "••••••" : answer?.answer ?? "")}`);
    }
  }
  return lines.join("\n");
}

export default function questionsExtension(
  pi: ExtensionAPI,
  options: QuestionsExtensionOptions = {},
): void {
  const child = options.isSubagentChild ?? process.env.PI_SUBAGENT_CHILD === "1";
  pi.registerTool({
    name: "questionnaire",
    label: "Questions",
    description: "Ask one or more structured questions. Each question offers terminal and configured Telegram input; the first reply wins.",
    promptSnippet: "Ask one or more structured questions with terminal and Telegram first-reply-wins input",
    promptGuidelines: [
      "Use questionnaire when user input is required to choose among meaningful alternatives instead of guessing.",
      "Keep questionnaire choices concise and distinct; freeform Other input is available by default.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_id: string, params: any, signal: AbortSignal, _update: any, ctx: ExtensionContext) {
      const questions = normalizeQuestions(params.questions);
      const displayedQuestions = publicQuestions(questions);
      const answers: QuestionAnswer[] = [];
      const telegram = child || options.telegramService === null
        ? undefined
        : options.telegramService ?? getTelegramService();
      let interrupted = false;
      let telegramWarningShown = false;

      try {
        for (const [index, question] of questions.entries()) {
          setAttentionTitle(pi, ctx, index, questions.length);
          const sources = [];
          const terminal = createTerminalReplySource(ctx, question, index, questions.length, Boolean(telegram));
          const telegramReply = telegram
            ? createTelegramQuestionReply(telegram, question, index, questions.length)
            : undefined;
          if (terminal) sources.push(terminal);
          if (telegramReply) sources.push(telegramReply.source);

          const outcome = await firstReplyWins(sources, {
            signal,
            onSourceError: (source, error) => {
              if (source !== "telegram" || telegramWarningShown) return;
              telegramWarningShown = true;
              ctx.ui.notify(safeTelegramQuestionError(error), "warning");
            },
          });
          if (telegramReply && outcome.source === "terminal") {
            void telegramReply.mirror(outcome).catch((error) => {
              if (telegramWarningShown) return;
              telegramWarningShown = true;
              ctx.ui.notify(safeTelegramQuestionError(error), "warning");
            });
          }

          if (outcome.status !== "answered") {
            interrupted = true;
            answers.push({
              id: question.id,
              question: question.question,
              cancelled: true,
              secret: question.secret || undefined,
              ...(outcome.status === "cancelled" && outcome.source ? { source: outcome.source } : {}),
            });
            break;
          }

          answers.push(question.secret
            ? {
              id: question.id,
              question: question.question,
              provided: true,
              secret: true,
              source: outcome.source,
            }
            : {
              id: question.id,
              question: question.question,
              answer: outcome.answer,
              source: outcome.source,
            });
        }
      } finally {
        if (questions.length > 0) clearAttentionTitle(pi, ctx);
      }

      const details: QuestionnaireDetails = { questions: displayedQuestions, answers, interrupted };
      const response = answers
        .filter(hasAnswer)
        .map((answer) => `${answer.id}: ${answer.secret ? "[secret provided]" : answer.answer}${answer.source === "telegram" ? " [via Telegram]" : ""}`)
        .join("\n");
      const unavailable = interrupted && answers.length === 1 && !answers[0].source && sourcesUnavailable(ctx, telegram);
      const suffix = unavailable
        ? "No reply channel is available. Open Pi in TUI mode or configure Telegram."
        : "Questionnaire interrupted";
      return {
        content: [{ type: "text", text: interrupted ? `${response}\n${suffix}`.trim() : response }],
        details,
      };
    },
    renderCall: () => new Text("", 0, 0),
    renderResult: (result: any, _renderOptions: any, theme: any) => new Text(
      recap(result.details ?? { questions: [], answers: [], interrupted: false }, theme),
      0,
      0,
    ),
    renderShell: "self",
  });

}

function sourcesUnavailable(ctx: ExtensionContext, telegram: TelegramService | undefined): boolean {
  return ctx.mode !== "tui" && !telegram;
}
