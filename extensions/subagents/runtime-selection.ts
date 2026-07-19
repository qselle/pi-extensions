export interface RuntimeModel {
  provider: string;
  id: string;
}

export interface RuntimeModelRegistry {
  find(provider: string, modelId: string): RuntimeModel | undefined;
  getApiKeyAndHeaders(model: RuntimeModel): Promise<{ ok: boolean; error?: string }>;
}

export interface RuntimeSelectionInput {
  currentModel?: RuntimeModel;
  currentThinking?: string;
  modelOverride?: string;
  thinkingOverride?: string;
  registry?: RuntimeModelRegistry;
}

export interface RuntimeSelection {
  model: string;
  thinking?: string;
}

export async function resolveRuntimeSelection(input: RuntimeSelectionInput): Promise<RuntimeSelection> {
  let model: string;
  if (input.modelOverride?.trim()) {
    const requested = input.modelOverride.trim();
    const separator = requested.indexOf("/");
    if (separator <= 0 || separator === requested.length - 1) {
      throw new Error("model must use provider/model format");
    }
    if (!input.registry) throw new Error("Cannot validate a subagent model without a model registry");
    const provider = requested.slice(0, separator);
    const modelId = requested.slice(separator + 1);
    const resolved = input.registry.find(provider, modelId);
    if (!resolved) throw new Error(`Unknown subagent model: ${requested}`);
    const auth = await input.registry.getApiKeyAndHeaders(resolved);
    if (!auth.ok) throw new Error(`Subagent model is unavailable: ${auth.error ?? "missing credentials"}`);
    model = `${resolved.provider}/${resolved.id}`;
  } else {
    if (!input.currentModel) throw new Error("Cannot spawn a subagent without an active parent model");
    model = `${input.currentModel.provider}/${input.currentModel.id}`;
  }
  return {
    model,
    thinking: input.thinkingOverride ?? input.currentThinking,
  };
}
