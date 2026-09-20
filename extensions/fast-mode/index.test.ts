import { expect, test } from "bun:test";
import register, { supportsFastMode } from "./index.ts";
const model = { provider: "openai", api: "openai-responses", id: "gpt-test", baseUrl: "https://api.openai.com/v1" };
test("capability gate rejects other protocols, proxies, fine tuning and malformed endpoints", () => {
  expect(supportsFastMode(model)).toBe(true);
  for (const change of [
    { provider: "other" }, { api: "openai-codex-responses" }, { id: "ft:test" },
    { baseUrl: "https://api.openai.com.evil.test/v1" }, { baseUrl: "http://api.openai.com/v1" },
    { baseUrl: "https://api.openai.com/v1?route=other" }, { baseUrl: "https://user@api.openai.com/v1" },
    { baseUrl: "not a url" },
  ]) expect(supportsFastMode({ ...model, ...change })).toBe(false);
});
test("explicit opt-in modifies only the current model's requests and resets on lifecycle changes", async () => {
  const handlers = new Map<string, any>();
  let command: any;
  const status: unknown[] = [];
  const ctx = { model, ui: { notify() {}, setStatus: (_key: string, value: unknown) => status.push(value) } };
  register({ on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: (_name: string, value: any) => { command = value; } } as any);
  const request = { model: model.id, input: [], service_tier: "auto" };
  const hook = () => handlers.get("before_provider_request")({ payload: request }, ctx);
  expect(hook()).toBeUndefined();
  await command.handler("on", ctx);
  expect(hook()).toEqual({ ...request, service_tier: "priority" });
  expect(request.service_tier).toBe("auto");
  expect(handlers.get("before_provider_request")({ payload: { model: "other" } }, ctx)).toBeUndefined();
  expect(handlers.get("before_provider_request")({ payload: null }, ctx)).toBeUndefined();
  for (const event of ["session_start", "session_tree", "model_select", "session_shutdown"]) {
    await command.handler("on", ctx);
    handlers.get(event)({}, ctx);
    expect(hook()).toBeUndefined();
    expect(status.at(-1)).toBeUndefined();
  }
  await command.handler("on", ctx);
  await command.handler("off", ctx);
  expect(hook()).toBeUndefined();
});

test("Codex transport permits only canonical ChatGPT endpoints with matching provider", () => {
  const codex = { ...model, provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
  for (const suffix of ["", "/", "/codex", "/codex/responses", "/codex/responses/"]) expect(supportsFastMode({ ...codex, baseUrl: codex.baseUrl + suffix })).toBe(true);
  for (const change of [{ provider: "openai" }, { api: "openai-responses" }, { baseUrl: "https://chatgpt.com/other" }, { baseUrl: "https://chatgpt.com.evil.test/backend-api" }, { baseUrl: "https://chatgpt.com/backend-api?x=1" }, { baseUrl: "http://chatgpt.com/backend-api" }]) expect(supportsFastMode({ ...codex, ...change })).toBe(false);
});
