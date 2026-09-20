import assert from "node:assert/strict";
import { stream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import register from "./index.ts";
const model = OPENAI_CODEX_MODELS["gpt-5.4"];
const handlers = new Map<string, any>(); let command: any;
const notices: string[] = [];
register({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (_: string, value: any) => { command = value; } } as any);
const ctx = { model, ui: { notify: (text: string) => notices.push(text), setStatus() {} } };
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.test`;
for (const enabled of [true, false]) {
  await command.handler(enabled ? "on" : "off", ctx);
  let sent = false;
  const response = stream(model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
    apiKey: token, transport: "sse", maxRetries: 0,
    onPayload: (payload) => handlers.get("before_provider_request")({ payload }, ctx),
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent = true;
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.service_tier, enabled ? "priority" : undefined);
      return new Response("fixture rejection", { status: 400 });
    }) as typeof fetch,
  });
  await response.result();
  assert(sent, "Adapter must reach the injected transport");
}
assert(notices.some((text) => text.includes("ChatGPT credit")));
console.log("Codex fast payload verified without network");
