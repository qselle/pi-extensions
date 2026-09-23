import { safeTelegramError, TelegramApiClient, type TelegramApiOptions } from "./api.ts";
import type { TelegramConfig } from "./config.ts";

export interface TelegramDiagnostic {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

/** Read-only health checks: no test messages, update consumption, or topic creation. */
export async function diagnoseTelegram(config: TelegramConfig, options: TelegramApiOptions = {}): Promise<TelegramDiagnostic[]> {
  const api = new TelegramApiClient(config, options);
  const [bot, chat, webhook] = await Promise.allSettled([
    api.call("getMe", {}),
    api.call("getChat", { chat_id: config.chatId }),
    api.call("getWebhookInfo", {}),
  ]);
  const checks: TelegramDiagnostic[] = [];
  const add = (name: string, status: TelegramDiagnostic["status"], message: string) => checks.push({ name, status, message });
  const validBot = bot.status === "fulfilled" && bot.value?.is_bot === true && Number.isSafeInteger(bot.value?.id) && bot.value.id > 0;
  const validChat = chat.status === "fulfilled" && ["private", "group", "supergroup", "channel"].includes(chat.value?.type);
  if (!validBot) add("Bot", "error", bot.status === "rejected" ? safeTelegramError(bot.reason) : "Telegram did not confirm a valid bot identity.");
  else add("Bot", "ok", "Token authenticated.");
  if (!validChat) add("Destination", "error", chat.status === "rejected" ? `${safeTelegramError(chat.reason)} Check the chat ID and start a chat with the bot or add it to the group.` : "Telegram did not confirm a valid destination.");
  else add("Destination", chat.value.type === "channel" ? "warning" : "ok", chat.value.type === "channel" ? "Channel found. Channel posts cannot answer Pi questions; use a private chat or group for replies." : `${chat.value.type === "private" ? "Private chat" : "Group"} found. Message delivery has not been tested.`);
  if (webhook.status === "rejected") add("Replies", "error", safeTelegramError(webhook.reason));
  else if (typeof webhook.value?.url !== "string") add("Replies", "error", "Telegram did not confirm webhook status.");
  else if (webhook.value.url) add("Replies", "error", "An active webhook blocks Pi reply polling. Use a dedicated bot or remove that webhook in its owning integration.");
  else add("Replies", "ok", "No webhook. Use one bot per machine to avoid competing pollers.");

  if (config.threadId !== undefined) add("Topics", "warning", "A fixed topic is configured. Its existence cannot be verified without a send.");
  else if (config.topics === "off") add("Topics", "ok", "Disabled; messages go to General.");
  else if (validChat && (chat.value.type !== "private" || validBot)) {
    const supported = chat.value.type === "private" ? bot.status === "fulfilled" && bot.value.has_topics_enabled === true : chat.value.is_forum === true;
    if (!supported) add("Topics", config.topics === "required" ? "error" : "warning", config.topics === "required" ? "Topics are required but unavailable. Enable forum topics or select /telegram topic auto." : "Topics are unavailable; automatic mode will use General. Enable bot topics in BotFather or forum topics in the supergroup.");
    else if (chat.value.type === "private") add("Topics", "ok", "Private-chat topics are enabled.");
    else if (validBot && bot.status === "fulfilled") {
      try {
        const member = await api.call("getChatMember", { chat_id: config.chatId, user_id: bot.value.id });
        const canManage = member?.status === "creator" || member?.status === "administrator" && member?.can_manage_topics === true;
        add("Topics", canManage ? "ok" : "error", canManage ? "Forum topics are enabled and the bot can manage them." : "The bot needs administrator permission to manage forum topics.");
      } catch (error) { add("Topics", "warning", `Topic permissions could not be checked. ${safeTelegramError(error)}`); }
    }
  }
  return checks;
}

export function formatTelegramDiagnostics(checks: readonly TelegramDiagnostic[]): string {
  return ["Telegram diagnostics (read-only)", ...checks.map((check) => `${check.status === "ok" ? "✓" : check.status === "warning" ? "!" : "✗"} ${check.name}: ${check.message}`)].join("\n");
}
