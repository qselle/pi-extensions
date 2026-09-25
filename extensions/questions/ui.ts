import { getMarkdownTheme, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Markdown,
  type Component,
  type Focusable,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Question } from "./model.ts";
import { cleanAnswer } from "./model.ts";
import type { ReplySource, SourceReply } from "./race.ts";

interface DisplayOption {
  label: string;
  custom: boolean;
}

export type QuestionPromptResult =
  | { status: "answered"; answer: string }
  | { status: "cancelled" }
  | { status: "superseded" };

class MaskedInput extends Input {
  override render(width: number): string[] {
    const value = this.getValue();
    this.setValue("•".repeat(value.length));
    try {
      return super.render(width);
    } finally {
      this.setValue(value);
    }
  }
}

export class QuestionPrompt implements Component, Focusable {
  private readonly options: DisplayOption[];
  private readonly input: Input;
  private readonly prompt: Markdown;
  private readonly choiceText: Markdown[];
  private selected = 0;
  private inputMode = false;
  private _focused = false;

  constructor(
    private readonly question: Question,
    private readonly index: number,
    private readonly total: number,
    private readonly telegramEnabled: boolean,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: QuestionPromptResult) => void,
  ) {
    this.options = question.options.map((label) => ({ label, custom: false }));
    if (question.allowOther || this.options.length === 0) {
      this.options.push({ label: "Other", custom: true });
    }
    this.prompt = new Markdown(question.question, 0, 0, getMarkdownTheme());
    this.choiceText = this.options.map((option) => new Markdown(
      option.custom ? `${option.label} · _type your answer_` : option.label,
      0,
      0,
      getMarkdownTheme(),
    ));
    this.input = question.secret ? new MaskedInput() : new Input();
    this.input.onSubmit = (value) => {
      const answer = cleanAnswer(value);
      if (!answer) return;
      this.done({ status: "answered", answer });
    };
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.inputMode;
  }

  handleInput(data: string): void {
    if (this.inputMode) {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.input.setValue("");
        if (this.options.length > 1) {
          this.inputMode = false;
          this.input.focused = false;
          this.tui.requestRender();
        } else {
          this.done({ status: "cancelled" });
        }
        return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        const answer = cleanAnswer(this.input.getValue());
        if (answer) this.done({ status: "answered", answer });
        return;
      }
      this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selected = (this.selected - 1 + this.options.length) % this.options.length;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selected = (this.selected + 1) % this.options.length;
      this.tui.requestRender();
      return;
    }
    if (/^[1-9]$/.test(data)) {
      const selected = Number(data) - 1;
      if (selected < this.options.length) {
        this.selected = selected;
        this.choose();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.choose();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ status: "cancelled" });
    }
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const inset = renderWidth > 4 ? 2 : 0;
    const inner = Math.max(1, renderWidth - inset * 2);
    const panel = (text: string, selected = false) => {
      const content = truncateToWidth(text, inner, "");
      const padded = content + " ".repeat(Math.max(0, inner - visibleWidth(content)));
      return this.theme.bg("customMessageBg", " ".repeat(inset))
        + this.theme.bg(selected ? "selectedBg" : "customMessageBg", padded)
        + this.theme.bg("customMessageBg", " ".repeat(inset));
    };
    const add = (text: string) => {
      for (const row of wrapTextWithAnsi(text, inner)) lines.push(panel(row));
    };

    lines.push(panel(""));
    add(this.theme.fg("accent", this.theme.bold(`Question ${this.index + 1}/${this.total}`)));
    for (const row of this.prompt.render(inner)) lines.push(panel(row));
    lines.push(panel(""));

    const firstChoice = Math.max(0, Math.min(this.selected - 2, this.options.length - 5));
    const lastChoice = Math.min(this.options.length, firstChoice + 5);
    if (firstChoice > 0) lines.push(panel(this.theme.fg("dim", `↑ ${firstChoice} more`)));
    for (let optionIndex = firstChoice; optionIndex < lastChoice; optionIndex++) {
      const option = this.options[optionIndex];
      const active = optionIndex === this.selected;
      const prefix = `${active ? this.theme.fg("accent", "▌") : " "} ${this.theme.fg("muted", `${optionIndex + 1}.`)} `;
      const prefixWidth = visibleWidth(prefix);
      const rendered = this.choiceText[optionIndex].render(Math.max(1, inner - prefixWidth));
      for (const [lineIndex, row] of rendered.entries()) {
        lines.push(panel(`${lineIndex === 0 ? prefix : " ".repeat(prefixWidth)}${row}`, active));
      }
    }
    if (lastChoice < this.options.length) {
      lines.push(panel(this.theme.fg("dim", `↓ ${this.options.length - lastChoice} more`)));
    }

    if (this.inputMode) {
      lines.push(panel(""));
      add(this.theme.fg("muted", this.question.secret ? "Secret answer (masked locally):" : "Your answer:"));
      for (const line of this.input.render(inner)) lines.push(panel(line));
    }

    lines.push(panel(""));
    if (this.telegramEnabled) {
      add(this.theme.fg("dim", "Waiting here and on Telegram · first reply wins"));
    }
    add(this.theme.fg(
      "dim",
      this.inputMode
        ? "Enter submit · Esc return"
        : "↑↓ navigate · Enter select · 1-9 quick select · Esc cancel",
    ));
    lines.push(panel(""));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
    this.prompt.invalidate();
    for (const choice of this.choiceText) choice.invalidate();
  }

  private choose(): void {
    const option = this.options[this.selected];
    if (!option) return;
    if (option.custom) {
      this.inputMode = true;
      this.input.focused = this._focused;
      this.tui.requestRender();
      return;
    }
    this.done({ status: "answered", answer: option.label });
  }
}

export function createTerminalReplySource(
  ctx: ExtensionContext,
  question: Question,
  index: number,
  total: number,
  telegramEnabled: boolean,
): ReplySource | undefined {
  if (ctx.mode !== "tui") return undefined;
  return {
    name: "terminal",
    run: async (signal): Promise<SourceReply> => {
      if (signal.aborted) return { status: "unavailable" };
      const result = await ctx.ui.custom<QuestionPromptResult>((tui, theme, keybindings, done) => {
        let finished = false;
        const finish = (value: QuestionPromptResult) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", supersede);
          done(value);
        };
        const supersede = () => finish({ status: "superseded" });
        signal.addEventListener("abort", supersede, { once: true });
        if (signal.aborted) queueMicrotask(supersede);
        const prompt = new QuestionPrompt(
          question,
          index,
          total,
          telegramEnabled,
          tui,
          theme,
          keybindings,
          finish,
        );
        return Object.assign(prompt, {
          dispose: () => signal.removeEventListener("abort", supersede),
        });
      });
      if (result.status === "answered") return result;
      return result.status === "cancelled" ? { status: "cancelled" } : { status: "unavailable" };
    },
  };
}
