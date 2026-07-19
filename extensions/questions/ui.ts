import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
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
    const runtime = this as unknown as { value: string };
    const value = runtime.value;
    runtime.value = "•".repeat(value.length);
    try {
      return super.render(width);
    } finally {
      runtime.value = value;
    }
  }
}

export class QuestionPrompt implements Component, Focusable {
  private readonly options: DisplayOption[];
  private readonly input: Input;
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
    const add = (text: string, prefix = "") => {
      const prefixWidth = visibleWidth(prefix);
      const available = Math.max(1, renderWidth - prefixWidth);
      const wrapped = wrapTextWithAnsi(text, available);
      for (let line = 0; line < wrapped.length; line++) {
        lines.push(truncateToWidth(
          `${line === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[line]}`,
          renderWidth,
          "",
        ));
      }
    };

    lines.push(this.theme.fg("borderAccent", "─".repeat(renderWidth)));
    add(this.theme.fg("accent", this.theme.bold(`Question ${this.index + 1} of ${this.total}`)), " ");
    add(this.theme.fg("text", this.question.question), " ");
    lines.push("");

    for (const [optionIndex, option] of this.options.entries()) {
      const active = optionIndex === this.selected;
      const pointer = active ? this.theme.fg("accent", "❯ ") : "  ";
      const marker = active ? this.theme.fg("accent", "●") : this.theme.fg("muted", "○");
      const suffix = option.custom ? this.theme.fg("muted", "  Type your own answer") : "";
      const label = `${marker} ${optionIndex + 1}. ${this.theme.fg(active ? "accent" : "text", option.label)}${suffix}`;
      add(label, pointer);
    }

    if (this.inputMode) {
      lines.push("");
      add(this.theme.fg("muted", this.question.secret ? "Secret answer (masked locally):" : "Your answer:"), " ");
      for (const line of this.input.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
    }

    lines.push("");
    if (this.telegramEnabled) {
      add(this.theme.fg("dim", "Waiting here and on Telegram — the first reply wins."), " ");
    }
    add(this.theme.fg(
      "dim",
      this.inputMode
        ? "Enter submit · Esc return"
        : "↑↓ navigate · Enter select · 1-9 quick select · Esc cancel",
    ), " ");
    lines.push(this.theme.fg("borderAccent", "─".repeat(renderWidth)));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
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
