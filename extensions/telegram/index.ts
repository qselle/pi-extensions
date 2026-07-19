import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_COMPLETED_EVENT } from "../goal/events.ts";
import { loadTelegramConfig } from "./config.ts";
import { safeTelegramError } from "./api.ts";
import { TelegramNotifier } from "./notifier.ts";
import {
  DefaultTelegramService,
  registerTelegramService,
  type TelegramService,
  type TelegramServiceOptions,
} from "./service.ts";

export interface TelegramExtensionOptions extends TelegramServiceOptions {
  env?: Readonly<Record<string, string | undefined>>;
  configFile?: string | false;
  isSubagentChild?: boolean;
  service?: TelegramService;
}

export interface TelegramRuntime {
  service: TelegramService;
  notifier: TelegramNotifier;
}

export default function telegramExtension(
  pi: ExtensionAPI,
  options: TelegramExtensionOptions = {},
): TelegramRuntime | undefined {
  const child = options.isSubagentChild ?? process.env.PI_SUBAGENT_CHILD === "1";
  if (child) return undefined;

  const configuration = options.service
    ? undefined
    : loadTelegramConfig({ env: options.env, configFile: options.configFile });
  const service = options.service ?? (configuration?.status === "enabled"
    ? new DefaultTelegramService(configuration.config, options)
    : undefined);
  const registration = service ? registerTelegramService(service) : undefined;
  let activeContext: ExtensionContext | undefined;
  const notifier = service
    ? new TelegramNotifier(
      service,
      configuration?.status === "enabled" ? configuration.config.details : "summary",
      { onFailure: (message) => activeContext?.ui.notify(message, "warning") },
    )
    : undefined;

  if (notifier) pi.events.on(GOAL_COMPLETED_EVENT, (event) => notifier.handle(event));

  pi.registerCommand("telegram-test", {
    description: "Test the shared Telegram integration",
    handler: async (_args, ctx) => {
      if (configuration?.status === "disabled" || (!configuration && !service)) {
        ctx.ui.notify("Telegram is disabled. Add telegram.json (or legacy telegram-notify.json), or set PI_TELEGRAM_BOT_TOKEN and PI_TELEGRAM_CHAT_ID, then reload.", "warning");
        return;
      }
      if (configuration?.status === "invalid") {
        ctx.ui.notify(configuration.message, "error");
        return;
      }
      try {
        await notifier!.sendTest();
        ctx.ui.notify("Telegram integration test sent.", "info");
      } catch (error) {
        ctx.ui.notify(safeTelegramError(error), "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    if (configuration?.status === "invalid") ctx.ui.notify(configuration.message, "warning");
  });

  pi.on("session_shutdown", async () => {
    registration?.unregister();
    await notifier?.drain();
    await service?.shutdown();
    activeContext = undefined;
  });

  return service && notifier ? { service, notifier } : undefined;
}
