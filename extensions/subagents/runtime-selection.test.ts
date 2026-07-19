import { expect, test } from "bun:test";
import { resolveRuntimeSelection } from "./runtime-selection.ts";

const registry = {
  find(provider: string, id: string) {
    return provider === "fast" && id === "model/variant" ? { provider, id } : undefined;
  },
  async getApiKeyAndHeaders() { return { ok: true }; },
};

test("inherits the parent model and thinking level by default", async () => {
  expect(await resolveRuntimeSelection({
    currentModel: { provider: "parent", id: "model" },
    currentThinking: "high",
    registry,
  })).toEqual({ model: "parent/model", thinking: "high" });
});

test("validates and applies explicit model and thinking overrides", async () => {
  expect(await resolveRuntimeSelection({
    currentModel: { provider: "parent", id: "model" },
    currentThinking: "high",
    modelOverride: "fast/model/variant",
    thinkingOverride: "low",
    registry,
  })).toEqual({ model: "fast/model/variant", thinking: "low" });
});

test("rejects malformed, unknown, and unavailable model overrides", async () => {
  await expect(resolveRuntimeSelection({ modelOverride: "missing-separator", registry })).rejects.toThrow("provider/model");
  await expect(resolveRuntimeSelection({ modelOverride: "unknown/model", registry })).rejects.toThrow("Unknown subagent model");
  await expect(resolveRuntimeSelection({
    modelOverride: "fast/model/variant",
    registry: { ...registry, async getApiKeyAndHeaders() { return { ok: false, error: "no credentials" }; } },
  })).rejects.toThrow("no credentials");
});
