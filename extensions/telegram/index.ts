import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { PlainOutput } from "../../lib/output.ts";
import { toolHeadline, toolText } from "../../lib/tool-ui.ts";
import { GOAL_COMPLETED_EVENT } from "../goal/events.ts";
import { safeTelegramError, TelegramApiClient, TelegramApiError } from "./api.ts";
import { SessionTopics, TOPIC_ENTRY } from "./topics.ts";
import { BotInbox } from "./inbox.ts";
import {
  loadTelegramConfig,
  saveTelegramConfig,
  type TelegramConfig,
  type TelegramConfigResult,
} from "./config.ts";
import { TelegramNotifier } from "./notifier.ts";
import { promptTelegramSetup } from "./setup.ts";
import { diagnoseTelegram, formatTelegramDiagnostics } from "./doctor.ts";
import { formatTelegramMessage, TelegramMessageError } from "./format.ts";
import {
  DefaultTelegramService,
  registerTelegramService,
  type TelegramService,
  type TelegramServiceOptions,
} from "./service.ts";

export interface TelegramExtensionOptions extends TelegramServiceOptions {
  env?: Readonly<Record<string, string | undefined>>;
  configFile?: string | false;
  inboxDirectory?: string;
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
  let topics: SessionTopics | undefined;

  const syncToolAvailability = (enableExplicitly = false) => {
    const selected = pi.getActiveTools();
    if (service && !enableExplicitly) return; // Respect --tools and manual tool selection.
    const active = selected.filter((name) => name !== "notify_user");
    pi.setActiveTools(service ? [...active, "notify_user"] : active);
  };

  const bindTopics = (ctx: ExtensionContext, name = pi.getSessionName?.()) => {
    const id = ctx.sessionManager?.getSessionId?.();
    if (!topics || !id) return;
    topics.bind({
      id, title: name, cwd: ctx.cwd,
      entries: ctx.sessionManager.getEntries(),
      save: (data) => pi.appendEntry(TOPIC_ENTRY, data),
    });
  };
  const makeService = (config: TelegramConfig) => {
    const api = new TelegramApiClient(config, options);
    topics = new SessionTopics(config, api);
    if (activeContext) bindTopics(activeContext);
    const inbox = options.inbox ?? new BotInbox(options.inboxDirectory ?? join(getAgentDir(), "telegram-inbox"), config.botToken, api, options.pollTimeoutSeconds);
    return new DefaultTelegramService(config, { ...options, topics, inbox });
  };

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
    installRuntime(makeService(configuration.config), configuration.config);
  }
  const initialRuntime = service && notifier ? { service, notifier } : undefined;

  const stopRuntime = async () => {
    const previousRegistration = registration;
    const previousNotifier = notifier;
    const previousService = service;
    registration = undefined;
    notifier = undefined;
    service = undefined;
    topics?.shutdown();
    topics = undefined;
    previousRegistration?.unregister();
    await previousNotifier?.drain();
    await previousService?.shutdown();
  };
  const replaceRuntime = async (config?: TelegramConfig) => {
    await stopRuntime();
    if (config) installRuntime(makeService(config), config);
    syncToolAvailability(true);
  };
  const persist = options.writeConfig ?? (async (config: TelegramConfig & { enabled: boolean }) => {
    await saveTelegramConfig(config, {
      env: options.env,
      configFile: options.configFile,
    });
  });

  const stopGoalListener = pi.events.on(GOAL_COMPLETED_EVENT, (event) => notifier?.handle(event));

  const sendDirect = async (message: string, ctx: ExtensionContext, signal?: AbortSignal) => {
    if (!service) throw new TelegramMessageError("Telegram is not enabled. Run /telegram setup or /telegram on.");
    const text = formatTelegramMessage(message);
    bindTopics(ctx);
    const sent = await service.send(text, { parseMode: "HTML", signal });
    if (!Number.isSafeInteger(sent.messageId) || sent.messageId! <= 0) {
      throw new TelegramMessageError("Telegram delivery was not confirmed. Check the chat before retrying to avoid a duplicate.");
    }
    return sent;
  };
  const directError = (error: unknown) => {
    if (error instanceof TelegramMessageError) return error.message;
    if (error instanceof Error && error.name === "AbortError") {
      return "Telegram notification cancelled. If sending had started, delivery may be unconfirmed; check the chat before retrying.";
    }
    const message = safeTelegramError(error);
    return error instanceof TelegramApiError && ["network", "timeout", "response"].includes(error.code)
      ? `${message} Delivery may be unconfirmed; check the chat before retrying.` : message;
  };

  pi.registerTool({
    name: "notify_user",
    label: "Notify via Telegram",
    description: "Send one Markdown message to the user's configured Telegram chat and current session topic. Use when the user asks for a Telegram notification or has authorized task notifications. Never use unsolicited, for secrets, or to request input/approval: use questionnaire for answers. Cannot select another recipient. Common Markdown is supported; rendered text must fit 4096 characters. Delivery errors can be unconfirmed: check before retrying.",
    promptSnippet: "Send requested task notifications to the user's configured Telegram chat.",
    promptGuidelines: ["Use notify_user only for requested or previously authorized task notifications; use questionnaire when you need a reply. Do not include credentials or secrets."],
    parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 16_384, description: "Concise Markdown notification; at most 4096 characters after formatting." }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const sent = await sendDirect(params.message, ctx, signal);
        return { content: [{ type: "text", text: "Telegram notification sent." }], details: { sent: true, messageId: sent.messageId } };
      } catch (error) {
        return { content: [{ type: "text", text: directError(error) }], details: { sent: false }, isError: true };
      }
    },
    renderShell: "self",
    renderCall: (args, theme, context) => toolHeadline(context?.isError ? "Telegram failed" : context?.isPartial ? "Notifying" : "Telegram", new PlainOutput().push(typeof args.message === "string" ? args.message : "").replace(/\s+/gu, " ").slice(0, 100), theme, context?.isError),
    renderResult: (result, _options, theme) => toolText(theme.fg((result.details as { sent?: boolean })?.sent ? "muted" : "error", result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")), true),
  });

  const handleTelegramCommand = async (rawAction: string, ctx: ExtensionContext) => {
    if (/^send(?:\s|$)/i.test(rawAction.trim())) {
      const message = rawAction.trim().replace(/^send\s*/i, "");
      if (!message) { ctx.ui.notify("Usage: /telegram send <Markdown message>", "info"); return; }
      try {
        await sendDirect(message, ctx);
        ctx.ui.notify("Telegram notification sent.", "info");
      } catch (error) { ctx.ui.notify(directError(error), "error"); }
      return;
    }
    if (/^topic(?:\s|$)/i.test(rawAction.trim())) {
      if (!topics) { ctx.ui.notify("Enable Telegram before configuring session topics.", "info"); return; }
      bindTopics(ctx);
      const status = await topics.command(rawAction.trim().replace(/^topic\s*/i, ""));
      ctx.ui.notify(`Telegram topics: ${status}`, "info");
      return;
    }
    const action = rawAction.trim().toLowerCase() || "status";
    if (action === "doctor") {
      if (injectedService) { ctx.ui.notify("Telegram diagnostics are unavailable for a custom injected service.", "warning"); return; }
      if (configuration?.status !== "enabled") {
        ctx.ui.notify(configuration?.status === "invalid" ? configuration.message : "Enable Telegram with /telegram setup or /telegram on before running diagnostics.", "warning");
        return;
      }
      bindTopics(ctx);
      const checks = await diagnoseTelegram({ ...configuration.config, topics: topics?.mode() ?? configuration.config.topics }, options);
      ctx.ui.notify(formatTelegramDiagnostics(checks), checks.some((check) => check.status === "error") ? "error" : checks.some((check) => check.status === "warning") ? "warning" : "info");
      return;
    }
    if (action === "status") {
      if (injectedService) {
        ctx.ui.notify("Telegram is on (custom service).", "info");
      } else if (configuration?.status === "enabled") {
        ctx.ui.notify(`Telegram is on (${formatDelay(configuration.config.questionDelayMinutes)} question delay).\nTopics: ${topics?.status() ?? "unavailable"}`, "info");
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
      ctx.ui.notify("Usage: /telegram setup|on|off|status|doctor|test|send <message>|topic", "warning");
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
    description: "Telegram setup, diagnostics, Markdown notifications, question replies and session topics",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["setup", "on", "off", "status", "doctor", "test", "send", "topic", "topic status", "topic auto", "topic required", "topic off", "topic retry", "topic new", "topic name", "topic follow"];
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
    syncToolAvailability();
    bindTopics(ctx);
    if (configuration?.status === "invalid") ctx.ui.notify(configuration.message, "warning");
  });
  pi.on("session_info_changed", (event, ctx) => {
    bindTopics(ctx, event.name);
    void topics?.syncName();
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
