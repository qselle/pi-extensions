import { describe, expect, test } from "bun:test";
import { requestTitle, type TitleRequestContext } from "./request.ts";

function context(available: string[] = ["anthropic/claude-haiku-4-5"], authOk = true): TitleRequestContext {
  return {
    model: { provider: "amazon-bedrock", id: "opus-5" },
    modelRegistry: {
      find: (provider, id) => (available.includes(`${provider}/${id}`) ? { provider, id } : undefined),
      getApiKeyAndHeaders: async () => (authOk
        ? { ok: true, apiKey: "k", headers: { h: "1" }, env: {} }
        : { ok: false, error: "no credentials" }),
    },
    sessionManager: { getSessionId: () => "sess-1" },
  };
}

const textResponse = (text: string, extra: Record<string, unknown> = {}) => async () => ({
  content: [{ type: "text", text }],
  usage: { input: 400, output: 6, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0004 } },
  ...extra,
});

describe("requestTitle", () => {
  test("returns a normalized title, model label, and usage", async () => {
    const result = await requestTitle({
      ctx: context(),
      prompt: "first_request: add hyperlinks",
      completion: textResponse('"Clickable file paths"') as never,
    });
    expect(result.title).toBe("Clickable file paths");
    expect(result.model).toBe("anthropic/claude-haiku-4-5");
    expect(result.usage).toEqual({ input: 400, output: 6, cost: 0.0004 });
    expect(result.error).toBeUndefined();
  });

  test("sends the titling system prompt, a bounded token cap, and a separate routing id", async () => {
    let seen: any;
    await requestTitle({
      ctx: context(),
      prompt: "p",
      completion: (async (model: any, request: any, options: any) => {
        seen = { model, request, options };
        return { content: [{ type: "text", text: "A title" }] };
      }) as never,
    });
    expect(seen.model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    expect(seen.request.systemPrompt).toContain("Reply with the title only");
    expect(seen.request.messages[0].content[0].text).toBe("p");
    expect(seen.options.maxTokens).toBe(32);
    // Must not share the main session's prompt cache.
    expect(seen.options.sessionId).toBe("sess-1:title");
    expect(seen.options.apiKey).toBe("k");
  });

  test("uses the cheap model rather than the session model when available", async () => {
    let used: any;
    await requestTitle({
      ctx: context(["anthropic/claude-haiku-4-5"]),
      prompt: "p",
      completion: (async (model: any) => { used = model; return { content: [] }; }) as never,
    });
    expect(used.id).toBe("claude-haiku-4-5");
  });

  test("falls back to the session model when no cheap model is available", async () => {
    let used: any;
    await requestTitle({
      ctx: context([]),
      prompt: "p",
      completion: (async (model: any) => { used = model; return { content: [{ type: "text", text: "T" }] }; }) as never,
    });
    expect(used).toEqual({ provider: "amazon-bedrock", id: "opus-5" });
  });

  test("honors a configured override", async () => {
    let used: any;
    await requestTitle({
      ctx: context(["openai/gpt-4.1-mini"]),
      override: "openai/gpt-4.1-mini",
      prompt: "p",
      completion: (async (model: any) => { used = model; return { content: [{ type: "text", text: "T" }] }; }) as never,
    });
    expect(used).toEqual({ provider: "openai", id: "gpt-4.1-mini" });
  });

  test("reports missing credentials instead of throwing", async () => {
    const result = await requestTitle({ ctx: context(["anthropic/claude-haiku-4-5"], false), prompt: "p" });
    expect(result.title).toBeUndefined();
    expect(result.error).toBe("no credentials");
  });

  test("reports a provider error", async () => {
    const result = await requestTitle({
      ctx: context(),
      prompt: "p",
      completion: textResponse("", { stopReason: "error", errorMessage: "rate limited" }) as never,
    });
    expect(result.error).toBe("rate limited");
  });

  test("reports an abort without a title", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await requestTitle({
      ctx: context(),
      prompt: "p",
      signal: controller.signal,
      completion: textResponse("Something") as never,
    });
    expect(result).toMatchObject({ error: "aborted" });
    expect(result.title).toBeUndefined();
  });

  test("reports an unusable answer", async () => {
    const result = await requestTitle({
      ctx: context(),
      prompt: "p",
      completion: textResponse("untitled") as never,
    });
    expect(result.title).toBeUndefined();
    expect(result.error).toContain("no usable title");
  });

  test("never throws when the completion itself fails", async () => {
    const result = await requestTitle({
      ctx: context(),
      prompt: "p",
      completion: (async () => { throw new Error("socket hang up"); }) as never,
    });
    expect(result.error).toBe("socket hang up");
  });

  test("accepts a plain string response body", async () => {
    const result = await requestTitle({
      ctx: context(),
      prompt: "p",
      completion: (async () => ({ content: "Plain title" })) as never,
    });
    expect(result.title).toBe("Plain title");
  });
});
