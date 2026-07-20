import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import {
  DEFAULT_TELEGRAM_QUESTION_DELAY_MINUTES,
  readTelegramConfig,
  type TelegramConfig,
} from "./config.ts";

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

class SecretPrompt implements Component, Focusable {
  private readonly input = new MaskedInput();
  private _focused = false;

  constructor(
    private readonly label: string,
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly done: (value: string | undefined) => void,
  ) {
    this.input.onSubmit = (value) => this.done(value.trim() || undefined);
    this.input.onEscape = () => this.done(undefined);
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const max = Math.max(1, width);
    return [
      ...wrapTextWithAnsi(this.label, max),
      ...this.input.render(max),
      ...wrapTextWithAnsi(this.theme.fg("dim", "Input is masked · Enter submit · Esc cancel"), max),
    ];
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

async function secretInput(label: string, ctx: ExtensionContext): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) =>
    new SecretPrompt(label, tui, theme, done));
}

export async function promptTelegramSetup(
  ctx: ExtensionContext,
  current?: TelegramConfig,
): Promise<TelegramConfig | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Telegram setup requires interactive TUI mode.", "warning");
    return undefined;
  }

  const botToken = await secretInput("Telegram bot token", ctx);
  if (!botToken) return undefined;
  const chatId = (await ctx.ui.input(
    "Telegram chat ID",
    current?.chatId ?? "Get your chat ID first",
  ))?.trim();
  if (!chatId) return undefined;
  const delayText = (await ctx.ui.input(
    "Question delay in minutes",
    String(current?.questionDelayMinutes ?? DEFAULT_TELEGRAM_QUESTION_DELAY_MINUTES),
  ))?.trim();
  if (!delayText) return undefined;

  const result = readTelegramConfig({}, {
    botToken,
    chatId,
    threadId: current?.threadId,
    details: current?.details ?? "summary",
    questionDelayMinutes: Number(delayText),
  });
  if (result.status !== "enabled") {
    ctx.ui.notify(
      result.status === "invalid" ? result.message : "Telegram setup is incomplete.",
      "error",
    );
    return undefined;
  }
  return result.config;
}
