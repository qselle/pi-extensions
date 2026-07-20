import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_COMPLETED_EVENT } from "../goal/events.ts";
import { safeTelegramError } from "./api.ts";
import {
  loadTelegramConfig,
  saveTelegramConfig,
  type TelegramConfig,
  type TelegramConfigResult,
} from "./config.ts";
import { TelegramNotifier } from "./notifier.ts";
import { promptTelegramSetup } from "./setup.ts";
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
  setupPrompt?: typeof promptTelegramSetup;
  writeConfig?(config: TelegramConfig & { enabled: boolean }): Promise<void>;
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

  const injectedService = Boolean(options.service);
  let configuration: TelegramConfigResult | undefined = injectedService
    ? undefined
    : loadTelegramConfig({ env: options.env, configFile: options.configFile });
  let service: TelegramService | undefined;
  let notifier: TelegramNotifier | undefined;
  let registration: { unregister(): void } | undefined;
  let activeContext: ExtensionContext | undefined;

  const installRuntime = (nextService: TelegramService, config?: TelegramConfig) => {
    service = nextService;
    registration = registerTelegramService(nextService);
    notifier = new TelegramNotifier(
      nextService,
      config?.details ?? "summary",
      { onFailure: (message) => activeContext?.ui.notify(message, "warning") },
    );
  };
  if (options.service) {
    installRuntime(options.service);
  } else if (configuration?.status === "enabled") {
    installRuntime(new DefaultTelegramService(configuration.config, options), configuration.config);
  }
  const initialRuntime = service && notifier ? { service, notifier } : undefined;

  const stopRuntime = async () => {
    const previousRegistration = registration;
    const previousNotifier = notifier;
    const previousService = service;
    registration = undefined;
    notifier = undefined;
    service = undefined;
    previousRegistration?.unregister();
    await previousNotifier?.drain();
    await previousService?.shutdown();
  };
  const replaceRuntime = async (config?: TelegramConfig) => {
    await stopRuntime();
    if (config) installRuntime(new DefaultTelegramService(config, options), config);
  };
  const persist = options.writeConfig ?? (async (config: TelegramConfig & { enabled: boolean }) => {
    await saveTelegramConfig(config, {
      env: options.env,
      configFile: options.configFile,
    });
  });

  const stopGoalListener = pi.events.on(GOAL_COMPLETED_EVENT, (event) => notifier?.handle(event));

  const handleTelegramCommand = async (rawAction: string, ctx: ExtensionContext) => {
    const action = rawAction.trim().toLowerCase() || "status";
    if (action === "status") {
      if (injectedService) {
        ctx.ui.notify("Telegram is on (custom service).", "info");
      } else if (configuration?.status === "enabled") {
        ctx.ui.notify(`Telegram is on (${formatDelay(configuration.config.questionDelayMinutes)} question delay).`, "info");
      } else if (configuration?.status === "disabled" && configuration.config) {
        ctx.ui.notify(`Telegram is off (${formatDelay(configuration.config.questionDelayMinutes)} question delay).`, "info");
      } else if (configuration?.status === "invalid") {
        ctx.ui.notify(configuration.message, "error");
      } else {
        ctx.ui.notify("Telegram is not configured. Run /telegram setup.", "info");
      }
      return;
    }

    if (action === "test") {
      if (!notifier) {
        if (configuration?.status === "invalid") ctx.ui.notify(configuration.message, "error");
        else ctx.ui.notify("Telegram is not enabled. Run /telegram setup or /telegram on.", "warning");
        return;
      }
      try {
        await notifier.sendTest();
        ctx.ui.notify("Telegram integration test sent.", "info");
      } catch (error) {
        ctx.ui.notify(safeTelegramError(error), "error");
      }
      return;
    }

    if (action === "setup") {
      if (injectedService) {
        ctx.ui.notify("Telegram setup is unavailable for a custom injected service.", "warning");
        return;
      }
      if (options.configFile === false && !options.writeConfig) {
        ctx.ui.notify("Telegram file configuration is disabled.", "warning");
        return;
      }
      const current = configuration && "config" in configuration ? configuration.config : undefined;
      const candidate = await (options.setupPrompt ?? promptTelegramSetup)(ctx, current);
      if (!candidate) return;
      const candidateService = new DefaultTelegramService(candidate, options);
      try {
        const sent = await candidateService.send("🧪 Pi Telegram setup test\n\nYour bot and chat ID are working.");
        if (sent.messageId === undefined) throw new Error("Telegram did not confirm the setup message.");
      } catch (error) {
        ctx.ui.notify(`Telegram setup test failed: ${safeTelegramError(error)}`, "error");
        return;
      } finally {
        await candidateService.shutdown();
      }
      try {
        await persist({ ...candidate, enabled: true });
      } catch {
        ctx.ui.notify("Telegram configuration could not be saved securely.", "error");
        return;
      }
      configuration = { status: "enabled", config: candidate };
      await replaceRuntime(candidate);
      ctx.ui.notify("Telegram configured and enabled; test message sent.", "info");
      return;
    }

    if (action !== "on" && action !== "off") {
      ctx.ui.notify("Usage: /telegram setup|on|off|status|test", "warning");
      return;
    }
    if (injectedService) {
      ctx.ui.notify("Telegram on/off is unavailable for a custom injected service.", "warning");
      return;
    }
    if (options.configFile === false && !options.writeConfig) {
      ctx.ui.notify("Telegram file configuration is disabled.", "warning");
      return;
    }
    const config = configuration && "config" in configuration ? configuration.config : undefined;
    if (!config) {
      ctx.ui.notify("Telegram is not configured. Run /telegram setup.", "warning");
      return;
    }
    const enable = action === "on";
    if ((configuration?.status === "enabled") === enable) {
      ctx.ui.notify(`Telegram is already ${enable ? "on" : "off"}.`, "info");
      return;
    }
    try {
      await persist({ ...config, enabled: enable });
      configuration = enable
        ? { status: "enabled", config }
        : { status: "disabled", config };
      await replaceRuntime(enable ? config : undefined);
      ctx.ui.notify(`Telegram ${enable ? "enabled" : "disabled"}.`, "info");
    } catch {
      ctx.ui.notify(`Telegram configuration could not be updated to ${enable ? "on" : "off"}.`, "error");
    }
  };

  pi.registerCommand("telegram", {
    description: "Set up and control Telegram integration",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["setup", "on", "off", "status", "test"];
      const matches = actions.filter((action) => action.startsWith(prefix.trim().toLowerCase()));
      return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
    },
    handler: handleTelegramCommand,
  });
  pi.registerCommand("telegram-test", {
    description: "Send a Telegram integration test (alias for /telegram test)",
    handler: async (_args, ctx) => handleTelegramCommand("test", ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    if (configuration?.status === "invalid") ctx.ui.notify(configuration.message, "warning");
  });

  pi.on("session_shutdown", async () => {
    stopGoalListener();
    await stopRuntime();
    activeContext = undefined;
  });

  return initialRuntime;
}

function formatDelay(minutes: number): string {
  if (minutes < 1) {
    const seconds = Math.max(1, Math.round(minutes * 60));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const value = Number.isInteger(minutes)
    ? String(minutes)
    : minutes.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
  return `${value} minute${minutes === 1 ? "" : "s"}`;
}
