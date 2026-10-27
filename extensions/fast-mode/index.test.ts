import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { isPriorityRejection, supportsFastMode } from "./index.ts";

const model = { provider: "openai", api: "openai-responses", id: "gpt-test", baseUrl: "https://api.openai.com/v1" };
const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.1-sol", baseUrl: "https://proxy.example/backend-api" };

function harness(configPath = join(mkdtempSync(join(tmpdir(), "fast-mode-")), "fast-mode.json")) {
  const handlers = new Map<string, any>();
  const badges: unknown[] = [];
  const notices: Array<[string, string]> = [];
  let command: any;
  const ctx: any = { model, ui: { notify: (text: string, level: string) => notices.push([text, level]) } };
  register({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (_name: string, value: any) => { command = value; },
    events: { emit: (name: string, value: unknown) => { if (name === "footer:badge") badges.push(value); } },
  } as any, { configPath });
  return {
    ctx, badges, notices, configPath,
    badge: () => (badges.at(-1) as { text?: string } | undefined)?.text,
    fire: (name: string, event: unknown = {}) => handlers.get(name)(event, ctx),
    command: (args: string) => command.handler(args, ctx),
  };
}

test("only service_tier protocols are eligible; endpoints and model IDs are not allowlisted", () => {
  for (const candidate of [model, codex, { ...model, id: "ft:custom" }, { ...model, baseUrl: "https://gateway.example/v1" }]) {
    expect(supportsFastMode(candidate)).toBe(true);
  }
  for (const change of [{ provider: "anthropic" }, { api: "openai-completions" }, { provider: "openai", api: "openai-codex-responses" }]) {
    expect(supportsFastMode({ ...model, ...change })).toBe(false);
  }
  expect(supportsFastMode(undefined)).toBe(false);
});

test("the saved preference requests priority without mutating payloads and persists across runtimes", async () => {
  const h = harness();
  const request = { model: model.id, input: [], service_tier: "auto" };
  h.fire("session_start");
  expect(h.badge()).toBeUndefined();
  expect(h.fire("before_provider_request", { payload: request })).toBeUndefined();
  await h.command("on");
  expect(JSON.parse(readFileSync(h.configPath, "utf8"))).toEqual({ enabled: true });
  expect(h.badges.at(-1)).toEqual({ id: "fast-mode", text: "fast", order: -10 });
  expect(h.fire("before_provider_request", { payload: request })).toEqual({ ...request, service_tier: "priority" });
  expect(request.service_tier).toBe("auto");
  for (const payload of [{ model: "side-request" }, null, []]) expect(h.fire("before_provider_request", { payload })).toBeUndefined();

  const restored = harness(h.configPath);
  restored.fire("session_start");
  expect(restored.badge()).toBe("fast");
  restored.ctx.model = { ...model, provider: "anthropic", api: "anthropic-messages" };
  restored.fire("model_select");
  expect(restored.badge()).toBeUndefined();
  expect(restored.fire("before_provider_request", { payload: { model: model.id } })).toBeUndefined();
  await restored.command("status");
  expect(restored.notices.at(-1)?.[0]).toContain("does not accept service_tier");

  await h.command("off");
  expect(h.badge()).toBeUndefined();
  expect(h.fire("before_provider_request", { payload: request })).toBeUndefined();
  expect(harness(h.configPath).fire("before_provider_request", { payload: request })).toBeUndefined();
  h.fire("session_shutdown");
  expect(h.badges.at(-1)).toEqual({ id: "fast-mode" });
});

test("an explicit priority rejection shows fast unavailable until the next request", async () => {
  const h = harness();
  h.ctx.model = codex;
  await h.command("on");
  h.fire("before_provider_request", { payload: { model: codex.id } });
  const message = { role: "assistant", provider: "openai-codex", model: codex.id, stopReason: "error", errorMessage: "Unknown parameter: 'service_tier'" };
  expect(h.fire("message_end", { message })).toBeUndefined();
  expect(h.badge()).toBe("fast unavailable");
  expect(h.notices.at(-1)).toEqual([expect.stringContaining("rejected"), "warning"]);
  await h.command("status");
  expect(h.notices.at(-1)?.[0]).toContain("rejected the last priority request");
  expect(h.fire("before_provider_request", { payload: { model: codex.id } })).toEqual({ model: codex.id, service_tier: "priority" });
  expect(h.badge()).toBe("fast");
  h.fire("message_end", { message: { ...message, errorMessage: "429 too many requests" } });
  expect(h.badge()).toBe("fast");
});

test("rejection matching ignores ordinary failures", () => {
  for (const error of ["Invalid service_tier: priority is not supported for this model", "Unknown parameter: 'service_tier'", "Priority service tier is not available for this account"]) {
    expect(isPriorityRejection(error)).toBe(true);
  }
  for (const error of ["429 too many requests", "Priority service request timed out", "Invalid tool schema; service_tier: priority", "Unsupported image format in priority request"]) {
    expect(isPriorityRejection(error)).toBe(false);
  }
});

test("a corrupt or unwritable config leaves fast mode off or session-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fast-mode-"));
  writeFileSync(join(dir, "fast-mode.json"), "{not json");
  const h = harness(join(dir, "fast-mode.json"));
  h.fire("session_start");
  expect(h.badge()).toBeUndefined();
  const blocked = harness(join(dir, "fast-mode.json", "nested.json"));
  await blocked.command("on");
  expect(blocked.notices.some(([text, level]) => level === "warning" && text.includes("session only"))).toBe(true);
  expect(blocked.fire("before_provider_request", { payload: { model: model.id } })).toEqual({ model: model.id, service_tier: "priority" });
});
