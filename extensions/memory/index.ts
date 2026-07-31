import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  agentDirectory,
  loadMemoryConfig,
  setMemoryEnabled,
  type MemoryConfig,
} from "./config.ts";
import {
  formatDisabledMemory,
  formatForgotten,
  formatMemoryRecord,
  formatMemorySearch,
  formatMemoryStatus,
  formatRemembered,
  mutationPreview,
} from "./format.ts";
import { MemoryStore } from "./store.ts";
import type {
  MemoryReadScope,
  MemoryScope,
} from "./types.ts";

const MemoryActionParameters = Type.Object({
  action: StringEnum(["status", "search", "read", "remember", "forget"] as const, {
    description: "Operation to perform.",
  }),
  query: Type.Optional(Type.String({ description: "Search query for action=search." })),
  id: Type.Optional(Type.String({ description: "Stable memory ID for action=read or action=forget." })),
  text: Type.Optional(Type.String({ description: "Exact user-approved text for action=remember." })),
  scope: Type.Optional(StringEnum(["project", "global", "all"] as const, {
    description: "Write scope or read selector. all is read-only and means current project plus global.",
  })),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
  expires_in_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_650 })),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  include_expired: Type.Optional(Type.Boolean()),
});

export interface MemoryActionInput {
  action: "status" | "search" | "read" | "remember" | "forget";
  query?: string;
  id?: string;
  text?: string;
  scope?: MemoryReadScope;
  tags?: string[];
  expires_in_days?: number;
  max_results?: number;
  include_expired?: boolean;
}

export interface MemoryActionDetails {
  action: MemoryActionInput["action"];
  cancelled?: boolean;
  result?: unknown;
}

export type MemoryCommandInput =
  | MemoryActionInput
  | { action: "enable" }
  | { action: "disable" };

export interface MemoryExtensionOptions {
  agentDir?: string;
  loadConfiguration?: (directory?: string) => MemoryConfig;
  createStore?: (ctx: ExtensionContext, root: string) => MemoryStore;
}

interface ActionResult {
  text: string;
  details: MemoryActionDetails;
}

type ActionSource = "tool" | "command";

export default function memoryExtension(pi: ExtensionAPI, options: MemoryExtensionOptions = {}): void {
  const agentDir = options.agentDir ?? agentDirectory();
  const loadConfig = options.loadConfiguration ?? loadMemoryConfig;
  const root = join(agentDir, "memory");

  const createStore = options.createStore ?? ((ctx: ExtensionContext, storeRoot: string) => new MemoryStore({
    root: storeRoot,
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager?.getSessionId?.(),
  }));

  const run = async (
    input: MemoryActionInput,
    ctx: ExtensionContext,
    source: ActionSource,
  ): Promise<ActionResult> => {
    const config = loadConfig(agentDir);
    if (!config.enabled) {
      if (input.action === "status") {
        return { text: formatDisabledMemory(root), details: { action: "status" } };
      }
      throw new Error("Memory is disabled in memory.json. Enable it and run /reload first.");
    }

    const store = createStore(ctx, root);
    switch (input.action) {
      case "status": {
        const status = await store.status();
        return { text: formatMemoryStatus(status), details: { action: "status", result: status } };
      }
      case "search": {
        const query = required(input.query, "query", "search");
        const results = await store.search({
          query,
          scope: input.scope ?? "all",
          maxResults: Math.min(input.max_results ?? config.maxSearchResults, config.maxSearchResults),
          includeExpired: input.include_expired,
        });
        return { text: formatMemorySearch(query, results), details: { action: "search", result: results } };
      }
      case "read": {
        const id = required(input.id, "id", "read");
        const record = await store.read(id, input.scope ?? "all");
        return {
          text: record ? formatMemoryRecord(record) : `Memory ${id} was not found in global or current-project scope.`,
          details: { action: "read", result: record },
        };
      }
      case "remember": {
        const text = required(input.text, "text", "remember");
        const scope = writeScope(input.scope, config.defaultScope);
        const approved = await approveToolMutation(
          source,
          config,
          ctx,
          "Remember explicit memory?",
          mutationPreview("remember", text, scope),
        );
        if (!approved) {
          return {
            text: "Memory write cancelled; nothing was persisted.",
            details: { action: "remember", cancelled: true },
          };
        }
        const result = await store.remember({
          text,
          scope,
          tags: input.tags,
          expiresInDays: input.expires_in_days,
        });
        return { text: formatRemembered(result), details: { action: "remember", result } };
      }
      case "forget": {
        const id = required(input.id, "id", "forget");
        const scope = input.scope ?? "all";
        const existing = await store.read(id, scope);
        if (!existing) {
          return {
            text: `Memory ${id} was not found in global or current-project scope.`,
            details: { action: "forget", result: {} },
          };
        }
        const approved = await approveToolMutation(
          source,
          config,
          ctx,
          "Forget explicit memory?",
          mutationPreview("forget", formatMemoryRecord(existing)),
        );
        if (!approved) {
          return {
            text: "Memory deletion cancelled; nothing changed.",
            details: { action: "forget", cancelled: true },
          };
        }
        const result = await store.forget(id, scope);
        return { text: formatForgotten(id, result), details: { action: "forget", result } };
      }
    }
  };

  const startupConfig = loadConfig(agentDir);
  if (startupConfig.enabled) {
    pi.registerTool({
      name: "memory",
      label: "Memory",
      description: "Search, read, explicitly remember, forget, or inspect local user-managed memory. Contents are never preloaded; search before read. Remember/forget only after a direct user request.",
      promptSnippet: "Search explicit local memory on demand; memory contents are never preloaded",
      promptGuidelines: [
        "Use memory with action=search when an explicit prior preference, project decision, or reusable workflow may help; use action=read only for a relevant returned ID.",
        "Use memory action=remember or action=forget only after the user directly asks to persist or remove memory; never infer mutation consent from an ordinary task.",
        "Treat memory results as potentially stale user-managed context; verify drift-prone facts against current files, and briefly identify materially relied-on unverified facts as memory-derived.",
      ],
      parameters: MemoryActionParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await run(params as MemoryActionInput, ctx, "tool");
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      },
    });
  }

  pi.registerCommand("memory", {
    description: "Configure, inspect, or explicitly edit local memory: /memory [enable|disable|status|search|read|remember|forget]",
    getArgumentCompletions: (prefix) => {
      const items = ["enable", "disable", "status", "search", "read", "remember", "forget"]
        .filter((action) => action.startsWith(prefix.toLowerCase()))
        .map((action) => ({ value: action, label: action }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        const config = loadConfig(agentDir);
        const input = parseMemoryCommand(args, config.defaultScope);
        if (input.action === "enable" || input.action === "disable") {
          const enabled = input.action === "enable";
          const path = await setMemoryEnabled(enabled, agentDir);
          ctx.ui.notify(formatCapabilityChange(enabled, path), "info");
          return;
        }
        const result = await run(input, ctx, "command");
        ctx.ui.notify(result.text, result.details.cancelled ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
}

export function parseMemoryCommand(args: string, defaultScope: MemoryScope): MemoryCommandInput {
  const input = args.trim();
  if (!input || input === "status") return { action: "status" };
  const firstSpace = input.search(/\s/);
  const action = (firstSpace < 0 ? input : input.slice(0, firstSpace)).toLowerCase();
  let rest = firstSpace < 0 ? "" : input.slice(firstSpace).trim();

  if (action === "status" && !rest) return { action: "status" };
  if ((action === "enable" || action === "disable") && !rest) return { action };
  if (action === "search") {
    if (!rest) throw new Error("Usage: /memory search <query>");
    return { action: "search", query: rest };
  }
  if (action === "read") {
    if (!rest || /\s/.test(rest)) throw new Error("Usage: /memory read <id>");
    return { action: "read", id: rest };
  }
  if (action === "forget") {
    if (!rest || /\s/.test(rest)) throw new Error("Usage: /memory forget <id>");
    return { action: "forget", id: rest };
  }
  if (action === "remember") {
    let scope = defaultScope;
    const flag = rest.match(/^--(global|project)(?:\s+|$)/);
    if (flag) {
      scope = flag[1] as MemoryScope;
      rest = rest.slice(flag[0].length).trim();
    }
    if (!rest) throw new Error("Usage: /memory remember [--project|--global] <text>");
    return { action: "remember", scope, text: rest };
  }
  throw new Error("Usage: /memory [enable|disable|status|search <query>|read <id>|remember [--project|--global] <text>|forget <id>]");
}

function formatCapabilityChange(enabled: boolean, path: string): string {
  return enabled
    ? [
        "Memory enabled persistently.",
        `config: ${path}`,
        "Stored memory records were not changed. Slash commands are available now.",
        "Run /reload to expose the memory tool to the model in this discussion.",
      ].join("\n")
    : [
        "Memory disabled persistently.",
        `config: ${path}`,
        "Stored memory records were not changed. Memory access is blocked now.",
        "Run /reload to remove the memory tool from this discussion.",
      ].join("\n");
}

async function approveToolMutation(
  source: ActionSource,
  config: MemoryConfig,
  ctx: ExtensionContext,
  title: string,
  message: string,
): Promise<boolean> {
  if (source === "command" || !config.confirmToolMutations) return true;
  if (!ctx.hasUI) {
    throw new Error("Memory tool mutations require an interactive confirmation. Use the explicit /memory remember or /memory forget command in headless mode.");
  }
  return ctx.ui.confirm(title, message);
}

function writeScope(scope: MemoryReadScope | undefined, fallback: MemoryScope): MemoryScope {
  const selected = scope ?? fallback;
  if (selected === "all") throw new Error("scope=all is read-only; choose project or global for remember.");
  return selected;
}

function required(value: string | undefined, field: string, action: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`memory ${action} requires ${field}.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
