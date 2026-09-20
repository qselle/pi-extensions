import { BotInbox } from "./inbox.ts";
import { TelegramApiClient } from "./api.ts";

const [root, endpoint, target] = process.argv.slice(2);
if (!root || !endpoint || !target) throw new Error("Missing fixture arguments");
const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const api = new TelegramApiClient({ botToken: token, chatId: "12345", details: "summary", questionDelayMinutes: 5 }, {
  fetch: (_url, init) => fetch(endpoint, init),
});
const inbox = new BotInbox(root, token, api, 0);
await inbox.initialize();
console.log("ready");
const signal = AbortSignal.timeout(8000);
while (true) {
  const updates = await inbox.read(signal);
  if (updates.some((update: any) => String(update.update_id) === target)) break;
}
console.log(`received ${target}`);
