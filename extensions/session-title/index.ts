/**
 * session-title — names a session once from its first meaningful request.
 *
 * Titling starts beside the main request, uses the active model by default, and
 * never blocks the agent turn. Existing and manually assigned names always win.
 * The bounded request has its own routing id, so it never enters the main
 * session's context or disturbs its prompt cache.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTitlePrompt, normalizeTitle, provisionalTitle } from "./engine.ts";
import { requestTitle, type TitleResult } from "./request.ts";

const CONFIG_FILE = "session-title.json";
const MAX_TRACKED_PROMPTS = 6;
const FOOTER_BADGE_EVENT = "footer:badge";
const TITLE_BADGE_ID = "session-title";

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
  /** Automatic generation is attempted at most once, even when it fails. */
  let autoAttempted = false;
  let last: TitleResult | undefined;
  let requestGeneration = 0;
  let activeRequest: AbortController | undefined;
  let titleBadge: string | undefined;

  const setTitleBadge = (text?: string) => {
    if (text === titleBadge) return;
    titleBadge = text;
    pi.events.emit(FOOTER_BADGE_EVENT, text
      ? { id: TITLE_BADGE_ID, text, order: -100 }
      : { id: TITLE_BADGE_ID });
  };

  const cancelRequest = () => {
    requestGeneration += 1;
    activeRequest?.abort();
    activeRequest = undefined;
    setTitleBadge();
  };

  const load = (ctx: ExtensionContext) => {
    cancelRequest();
    prompts = [];
    named = Boolean(pi.getSessionName());
    last = undefined;
    // Existing branches have already passed their first-request boundary. They
    // remain untouched unless the user explicitly runs `/title now`.
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const text = userText(entry.message.content);
      if (text) prompts.push(text);
    }
    if (prompts.length > MAX_TRACKED_PROMPTS) prompts = prompts.slice(-MAX_TRACKED_PROMPTS);
    autoAttempted = named || prompts.some((prompt) => Boolean(provisionalTitle(prompt)));
  };

  const generate = async (
    ctx: ExtensionContext,
    sourcePrompts: readonly string[],
    force: boolean,
  ): Promise<TitleResult> => {
    cancelRequest();
    const generation = requestGeneration;
    const controller = new AbortController();
    activeRequest = controller;
    setTitleBadge(pi.getSessionName() ? "renaming…" : "naming…");
    let result: TitleResult;
    try {
      result = await run({
        ctx: ctx as never,
        prompt: buildTitlePrompt(sourcePrompts),
        override: config.model,
        signal: controller.signal,
      });
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    if (generation !== requestGeneration) return result;
    activeRequest = undefined;
    setTitleBadge();
    last = result;
    if (result.title && (force || !pi.getSessionName())) {
      pi.setSessionName(result.title);
      named = true;
    } else if (pi.getSessionName()) {
      named = true;
    }
    return result;
  };

  const generateAutomatically = (ctx: ExtensionContext, prompt: string) => {
    autoAttempted = true;
    void generate(ctx, [prompt], false);
  };

  pi.on("session_start", (_event, ctx) => load(ctx));
  pi.on("session_tree", (_event, ctx) => load(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    const prompt = event.prompt.trim();
    if (!prompt) return undefined;
    prompts.push(prompt);
    if (prompts.length > MAX_TRACKED_PROMPTS) prompts = prompts.slice(-MAX_TRACKED_PROMPTS);

    // The extraction helper is only a substantive-request check here; its text
    // is never shown. Titling runs beside the main request and is not awaited.
    if (pi.getSessionName()) named = true;
    if (config.enabled && !named && !autoAttempted && provisionalTitle(prompt)) {
      generateAutomatically(ctx, prompt);
    }
    return undefined;
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
        cancelRequest();
        pi.setSessionName(title);
        named = true;
        autoAttempted = true;
        ctx.ui.notify(`Title set to “${title}”.`, "info");
        return;
      }

      if (action === "now") {
        if (prompts.length === 0) {
          ctx.ui.notify("Nothing to title yet.", "info");
          return;
        }
        const result = await generate(ctx as never, prompts, true);
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
      ctx.ui.notify(statusText(config, pi.getSessionName(), prompts.length, last, autoAttempted), "info");
    },
  });

  pi.on("session_shutdown", () => cancelRequest());
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
  autoAttempted = Boolean(last),
): string {
  const automatic = !config.enabled
    ? "off"
    : title
      ? "done (named)"
      : autoAttempted
        ? "attempted (unnamed)"
        : "pending";
  const lines = [
    `title: ${title ?? "(none)"}`,
    `automatic: ${automatic}`,
    `model: ${config.model ?? "active session model"}`,
    `prompts tracked: ${promptCount}`,
  ];
  if (last?.usage) lines.push(`last request: ${last.model ?? "?"} · $${last.usage.cost.toFixed(4)}`);
  if (last?.error) lines.push(`last error: ${last.error}`);
  return lines.join("\n");
}
