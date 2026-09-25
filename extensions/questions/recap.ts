import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionAnswer, QuestionnaireDetails } from "./model.ts";
import { plainText } from "../../lib/transcript/model.ts";

export function hasAnswer(answer: QuestionAnswer | undefined): boolean {
  return Boolean(answer && (answer.answer !== undefined || answer.provided));
}

/** Keep the chosen answer readable without reopening the full questionnaire. */
export class QuestionRecap implements Component {
  private readonly entries;

  constructor(private readonly details: QuestionnaireDetails, private readonly expanded: boolean, private readonly theme: Theme) {
    const markdown = (text: string) => new Markdown(plainText(text), 0, 0, getMarkdownTheme());
    this.entries = details.questions.map((question) => {
      const answer = details.answers.find((candidate) => candidate.id === question.id);
      // Mask even malformed/legacy records that accidentally retained an answer.
      const secret = question.secret || answer?.secret;
      return {
        answer,
        prompt: markdown(question.question),
        chosen: hasAnswer(answer) ? markdown(secret ? "•••••• · secret provided" : answer?.answer ?? "") : undefined,
        choices: secret ? [] : (question.options ?? []).map((option) => ({
          selected: option === answer?.answer,
          text: markdown(option),
        })),
        handle: secret && hasAnswer(answer) ? answer?.handle : undefined,
      };
    });
  }

  invalidate(): void {
    for (const entry of this.entries) {
      entry.prompt.invalidate();
      entry.chosen?.invalidate();
      for (const choice of entry.choices) choice.text.invalidate();
    }
  }

  render(width: number): string[] {
    if (!Number.isFinite(width) || width < 1) return [];
    width = Math.floor(width);
    const { theme } = this;
    const answered = this.entries.filter((entry) => hasAnswer(entry.answer)).length;
    const lines = [`${theme.fg("accent", "•")} ${theme.bold("Questions")} ${theme.fg("muted", `· ${answered}/${this.entries.length} answered`)}${this.details.interrupted ? theme.fg("warning", " · interrupted") : ""}`];
    const indent = width > 8 ? "  " : "";
    const inner = Math.max(1, width - indent.length);
    let omitted = false;
    const add = (component: Markdown, prefix: string, shaded = false, limit = 2) => {
      const prefixWidth = visibleWidth(prefix);
      const rows = component.render(Math.max(1, inner - prefixWidth));
      const visible = this.expanded ? rows : rows.slice(0, limit);
      omitted ||= visible.length < rows.length;
      for (const [index, row] of visible.entries()) {
        const content = truncateToWidth(`${index ? " ".repeat(prefixWidth) : prefix}${row}`, inner, "");
        lines.push(indent + (shaded
          ? theme.bg("customMessageBg", content + " ".repeat(Math.max(0, inner - visibleWidth(content))))
          : content));
      }
    };
    for (const [index, entry] of this.entries.entries()) {
      if (index) lines.push("");
      add(entry.prompt, theme.fg("muted", `${index + 1}. `));
      if (entry.chosen) {
        add(entry.chosen, theme.fg("accent", "› "), true);
        if (entry.answer?.source === "telegram") lines.push(indent + theme.fg("dim", "   via Telegram"));
      } else {
        lines.push(indent + theme.fg("muted", entry.answer?.cancelled ? "   Cancelled" : "   Unanswered"));
      }
      if (this.expanded) {
        if (entry.handle) lines.push(indent + theme.fg("dim", `   ${plainText(entry.handle)}`));
        for (const choice of entry.choices) {
          add(choice.text, theme.fg(choice.selected ? "accent" : "dim", choice.selected ? "  ✓ " : "  · "));
        }
      }
    }
    if (!this.expanded && (omitted || this.entries.some((entry) => entry.choices.length))) {
      lines.push(indent + keyHint("app.tools.expand", omitted ? "for full answers and choices" : "for choices"));
    }
    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}
