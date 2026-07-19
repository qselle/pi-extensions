import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_COMPLETED_EVENT } from "../goal/events.ts";
import { loadTelegramConfig } from "./config.ts";
import { TelegramNotifier, safeDeliveryError } from "./notifier.ts";
import type { TelegramTransportOptions } from "./telegram.ts";

export interface TelegramNotifyExtensionOptions extends TelegramTransportOptions {
  env?: Readonly<Record<string, string | undefined>>;
  configFile?: string | false;
  isSubagentChild?: boolean;
}

export default function telegramNotifyExtension(
  pi: ExtensionAPI,
  options: TelegramNotifyExtensionOptions = {},
): TelegramNotifier | undefined {
  const child = options.isSubagentChild ?? process.env.PI_SUBAGENT_CHILD === "1";
  if (child) return undefined;

  const configuration = loadTelegramConfig({
    env: options.env,
    configFile: options.configFile,
  });
  let activeContext: ExtensionContext | undefined;
  const notifier = configuration.status === "enabled"
    ? new TelegramNotifier(
      configuration.config,
      { fetch: options.fetch, sleep: options.sleep, timeoutMs: options.timeoutMs },
      {
        onFailure: (message) => activeContext?.ui.notify(message, "warning"),
      },
    )
    : undefined;

  if (notifier) pi.events.on(GOAL_COMPLETED_EVENT, (event) => notifier.handle(event));

  pi.registerCommand("telegram-test", {
    description: "Send an explicit Telegram configuration test",
    handler: async (_args, ctx) => {
      if (configuration.status === "disabled") {
        ctx.ui.notify("Telegram notifications are disabled. Add telegram-notify.json or set PI_TELEGRAM_BOT_TOKEN and PI_TELEGRAM_CHAT_ID, then reload.", "warning");
        return;
      }
      if (configuration.status === "invalid") {
        ctx.ui.notify(configuration.message, "error");
        return;
      }
      try {
        await notifier!.sendTest();
        ctx.ui.notify("Telegram test notification sent.", "info");
      } catch (error) {
        ctx.ui.notify(safeDeliveryError(error), "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    if (configuration.status === "invalid") ctx.ui.notify(configuration.message, "warning");
  });

  pi.on("session_shutdown", async () => {
    await notifier?.drain();
    activeContext = undefined;
  });

  return notifier;
}
