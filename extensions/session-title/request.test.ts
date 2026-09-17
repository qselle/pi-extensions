import { describe, expect, test } from "bun:test";
import { requestTitle, type TitleRequestContext } from "./request.ts";

function context(available: string[] = ["anthropic/claude-haiku-4-5"], authOk = true): TitleRequestContext {
  return {
    model: { provider: "amazon-bedrock", id: "opus-5", reasoning: true },
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
    expect(result.model).toBe("amazon-bedrock/opus-5");
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
    expect(seen.model).toEqual({ provider: "amazon-bedrock", id: "opus-5", reasoning: true });
    expect(seen.request.systemPrompt).toContain("Reply only with a specific noun phrase");
    expect(seen.request.messages[0].content[0].text).toBe("p");
    expect(seen.options.maxTokens).toBe(24);
    expect(seen.options.reasoning).toBe("off");
    // Must not share the main session's prompt cache.
    expect(seen.options.sessionId).toBe("sess-1:title");
    expect(seen.options.apiKey).toBe("k");
  });

  test("forwards provider headers unchanged, including null deletion markers", async () => {
    const base = context();
    let seen: any;
    await requestTitle({
      ctx: {
        ...base,
        modelRegistry: {
          ...base.modelRegistry,
          // Pi 0.84 returns ProviderHeaders, where null deletes a default header.
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: "k",
            headers: { "x-keep": "1", "x-drop": null },
            env: {},
          }),
        },
      },
      prompt: "p",
      completion: (async (_model: any, _request: any, options: any) => {
        seen = options;
        return { content: [{ type: "text", text: "A title" }] };
      }) as never,
    });

    expect(seen.headers).toEqual({ "x-keep": "1", "x-drop": null });
  });

  test("uses the active session model by default, regardless of other catalogue models", async () => {
    let used: any;
    await requestTitle({
      ctx: context(["anthropic/claude-haiku-4-5"]),
      prompt: "p",
      completion: (async (model: any) => { used = model; return { content: [{ type: "text", text: "T" }] }; }) as never,
    });
    expect(used).toEqual({ provider: "amazon-bedrock", id: "opus-5", reasoning: true });
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

  test("falls back to the active model when a configured override is unavailable", async () => {
    let used: any;
    const result = await requestTitle({
      ctx: context([]),
      override: "openai/not-installed",
      prompt: "p",
      completion: (async (model: any) => {
        used = model;
        return { content: [{ type: "text", text: "Portable Title" }] };
      }) as never,
    });
    expect(used).toEqual({ provider: "amazon-bedrock", id: "opus-5", reasoning: true });
    expect(result.title).toBe("Portable Title");
  });

  test("falls back to the active model when the configured override fails", async () => {
    const used: string[] = [];
    const result = await requestTitle({
      ctx: context(["openai/gpt-4.1-mini"]),
      override: "openai/gpt-4.1-mini",
      prompt: "p",
      completion: (async (model: any) => {
        used.push(`${model.provider}/${model.id}`);
        return model.provider === "openai"
          ? { stopReason: "error", errorMessage: "rate limited", content: [] }
          : { content: [{ type: "text", text: "Active Model Title" }] };
      }) as never,
    });
    expect(used).toEqual(["openai/gpt-4.1-mini", "amazon-bedrock/opus-5"]);
    expect(result.title).toBe("Active Model Title");
    expect(result.model).toBe("amazon-bedrock/opus-5");
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
