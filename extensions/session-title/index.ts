/**
 * session-title — names a session once, then leaves it alone.
 *
 * A free local title appears the moment you send the first prompt. After the turn
 * settles, one bounded request on a cheap model replaces it. A session that
 * already has a name is never touched, so `/name` is always safe.
 *
 * The request carries only user text on its own routing id, so it never enters the
 * main session's context or disturbs its prompt cache.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTitlePrompt, normalizeTitle, provisionalTitle } from "./engine.ts";
import { requestTitle, type TitleResult } from "./request.ts";

const CONFIG_FILE = "session-title.json";
const MAX_TRACKED_PROMPTS = 6;

export interface SessionTitleConfig {
  enabled: boolean;
  /** "provider/model" override for the titling request. */
  model?: string;
}

export function agentDirectory(): string {
  return getAgentDir();
}

export function loadConfig(directory = agentDirectory()): SessionTitleConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, CONFIG_FILE), "utf8")) as Record<string, unknown>;
    return {
      enabled: parsed?.enabled !== false,
      model: typeof parsed?.model === "string" && parsed.model.includes("/") ? parsed.model : undefined,
    };
  } catch {
    return { enabled: true };
  }
}

export interface SessionTitleOptions {
  config?: SessionTitleConfig;
  request?: typeof requestTitle;
}

export default function sessionTitleExtension(pi: ExtensionAPI, options: SessionTitleOptions = {}): void {
  const config = options.config ?? loadConfig();
  const run = options.request ?? requestTitle;

  let prompts: string[] = [];
  /** True once the session has a name, from any source. Titling stops for good. */
  let named = false;
  let last: TitleResult | undefined;

  const load = (ctx: ExtensionContext) => {
    prompts = [];
    named = Boolean(pi.getSessionName());
    last = undefined;
    // Recover prompts so a resumed or reloaded session can still be titled.
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const text = userText(entry.message.content);
      if (text) prompts.push(text);
    }
    if (prompts.length > MAX_TRACKED_PROMPTS) prompts = prompts.slice(-MAX_TRACKED_PROMPTS);
  };

  const generate = async (ctx: ExtensionContext): Promise<TitleResult> => {
    const result = await run({ ctx: ctx as never, prompt: buildTitlePrompt(prompts), override: config.model, signal: ctx.signal });
    last = result;
    if (result.title) {
      pi.setSessionName(result.title);
      named = true;
    }
    return result;
  };

  pi.on("session_start", (_event, ctx) => load(ctx));
  pi.on("session_tree", (_event, ctx) => load(ctx));

  pi.on("before_agent_start", (event) => {
    const prompt = event.prompt.trim();
    if (!prompt) return undefined;
    prompts.push(prompt);
    if (prompts.length > MAX_TRACKED_PROMPTS) prompts = prompts.slice(-MAX_TRACKED_PROMPTS);
    // Free placeholder so the session is identifiable immediately.
    if (config.enabled && !named) {
      const provisional = provisionalTitle(prompt);
      if (provisional) pi.setSessionName(provisional);
    }
    return undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!config.enabled || named || prompts.length === 0) return;
    await generate(ctx);
  });

  pi.registerCommand("title", {
    description: "Session title: /title [status|now|set <text>]",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "now", "set"]
        .filter((value) => value.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [command = "", ...rest] = args.trim().split(/\s+/);
      const action = command.toLowerCase();

      if (action === "set") {
        const title = normalizeTitle(rest.join(" "));
        if (!title) {
          ctx.ui.notify("Usage: /title set <text>", "error");
          return;
        }
        pi.setSessionName(title);
        named = true;
        ctx.ui.notify(`Title set to “${title}”.`, "info");
        return;
      }

      if (action === "now") {
        if (prompts.length === 0) {
          ctx.ui.notify("Nothing to title yet.", "info");
          return;
        }
        const result = await generate(ctx as never);
        ctx.ui.notify(
          result.title
            ? `Title: “${result.title}” (${result.model ?? "?"}, $${(result.usage?.cost ?? 0).toFixed(4)})`
            : `Titling failed: ${result.error ?? "unknown error"}`,
          result.title ? "info" : "error",
        );
        return;
      }

      if (action && action !== "status") {
        ctx.ui.notify("Usage: /title [status|now|set <text>]", "error");
        return;
      }
      ctx.ui.notify(statusText(config, pi.getSessionName(), prompts.length, last), "info");
    },
  });
}

/** Plain text of a user message, ignoring images and other non-text blocks. */
function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join(" ")
    .trim();
}

export function statusText(
  config: SessionTitleConfig,
  title: string | undefined,
  promptCount: number,
  last: TitleResult | undefined,
): string {
  const lines = [
    `title: ${title ?? "(none)"}`,
    `automatic: ${config.enabled ? (title ? "done (named)" : "pending") : "off"}`,
    `model: ${config.model ?? "cheapest available"}`,
    `prompts tracked: ${promptCount}`,
  ];
  if (last?.usage) lines.push(`last request: ${last.model ?? "?"} · $${last.usage.cost.toFixed(4)}`);
  if (last?.error) lines.push(`last error: ${last.error}`);
  return lines.join("\n");
}
