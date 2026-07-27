/**
 * session-title — names the session automatically.
 *
 * A free local title appears the moment you send the first prompt, then one
 * bounded request on a cheap model replaces it with a real one. Refreshed only
 * every few user turns, and never again after you rename with /name.
 *
 * The titling request runs on its own routing id with only user text, so it never
 * enters the main session's context or disturbs its prompt cache.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_REFRESH_EVERY,
  buildTitlePrompt,
  normalizeTitle,
  provisionalTitle,
  shouldGenerate,
  type RefreshState,
} from "./engine.ts";
import { requestTitle, type TitleResult } from "./request.ts";

const CONFIG_FILE = "session-title.json";
const MAX_TRACKED_PROMPTS = 8;

export interface SessionTitleConfig {
  enabled: boolean;
  /** "provider/model" override for the titling request. */
  model?: string;
  refreshEvery: number;
}

export function agentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function loadConfig(directory = agentDirectory()): SessionTitleConfig {
  const defaults: SessionTitleConfig = { enabled: true, refreshEvery: DEFAULT_REFRESH_EVERY };
  try {
    const parsed = JSON.parse(readFileSync(join(directory, CONFIG_FILE), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return defaults;
    const record = parsed as Record<string, unknown>;
    return {
      enabled: record.enabled !== false,
      model: typeof record.model === "string" && record.model.includes("/") ? record.model : undefined,
      refreshEvery: typeof record.refreshEvery === "number" && record.refreshEvery > 0
        ? Math.floor(record.refreshEvery)
        : DEFAULT_REFRESH_EVERY,
    };
  } catch {
    return defaults;
  }
}

export interface SessionTitleOptions {
  config?: SessionTitleConfig;
  request?: typeof requestTitle;
}

export default function sessionTitleExtension(pi: ExtensionAPI, options: SessionTitleOptions = {}): void {
  const config = options.config ?? loadConfig();
  const run = options.request ?? requestTitle;

  let state: RefreshState = { userTurns: 0 };
  let anchor: string | undefined;
  let recent: string[] = [];
  let currentTitle: string | undefined;
  /** The last title this extension set, used to detect a manual rename. */
  let ownTitle: string | undefined;
  let last: TitleResult | undefined;
  let inFlight = false;

  const reset = () => {
    state = { userTurns: 0 };
    anchor = undefined;
    recent = [];
    currentTitle = pi.getSessionName() || undefined;
    ownTitle = currentTitle;
    last = undefined;
  };

  /**
   * Recovers history when loading into an existing session (resume, /reload, or
   * tree navigation), so titling works without waiting for a fresh prompt.
   */
  const hydrate = (ctx: ExtensionContext) => {
    reset();
    const texts: string[] = [];
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      const message = (entry as any)?.message;
      if ((entry as any)?.type !== "message" || message?.role !== "user") continue;
      const text = userText(message.content);
      if (text) texts.push(text);
    }
    state.userTurns = texts.length;
    anchor = texts[0];
    recent = texts.slice(-MAX_TRACKED_PROMPTS);
    // An existing name is left alone until the refresh interval passes, so a
    // resume never silently spends on a retitle.
    if (currentTitle && texts.length > 0) state.titledAtTurn = texts.length;
  };

  const apply = (title: string) => {
    currentTitle = title;
    ownTitle = title;
    pi.setSessionName(title);
  };

  const generate = async (ctx: ExtensionContext): Promise<TitleResult> => {
    const prompt = buildTitlePrompt({ anchor, recent, currentTitle });
    const result = await run({
      ctx: ctx as never,
      prompt,
      override: config.model,
      signal: ctx.signal,
    });
    last = result;
    state.titledAtTurn = state.userTurns;
    if (result.title && result.title !== currentTitle) apply(result.title);
    return result;
  };

  pi.on("session_start", (_event, ctx) => hydrate(ctx));
  pi.on("session_tree", (_event, ctx) => hydrate(ctx));

  pi.on("before_agent_start", (event) => {
    if (!config.enabled || state.manual) return undefined;
    const prompt = typeof (event as any)?.prompt === "string" ? (event as any).prompt.trim() : "";
    if (!prompt) return undefined;

    state.userTurns += 1;
    anchor ??= prompt;
    recent.push(prompt);
    if (recent.length > MAX_TRACKED_PROMPTS) recent = recent.slice(-MAX_TRACKED_PROMPTS);

    // Free placeholder so the session is identifiable immediately.
    if (!currentTitle) {
      const provisional = provisionalTitle(prompt);
      if (provisional) apply(provisional);
    }
    return undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!config.enabled || inFlight) return;
    if (!shouldGenerate(state, config.refreshEvery)) return;
    inFlight = true;
    try {
      await generate(ctx);
    } finally {
      inFlight = false;
    }
  });

  pi.on("session_info_changed", (event) => {
    const name = (event as any)?.name as string | undefined;
    // A name this extension did not set means the user renamed it: stop titling.
    if (name && name !== ownTitle) {
      state.manual = true;
      currentTitle = name;
      ownTitle = name;
    }
  });

  pi.registerCommand("title", {
    description: "Session title: /title [status|now|set <text>|auto]",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "now", "set", "auto"]
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
        state.manual = true;
        apply(title);
        ctx.ui.notify(`Title set to “${title}”. Automatic titling is off for this session.`, "info");
        return;
      }

      if (action === "auto") {
        state.manual = false;
        state.titledAtTurn = undefined;
        ctx.ui.notify("Automatic titling re-enabled.", "info");
        return;
      }

      if (action === "now") {
        if (state.userTurns === 0) {
          ctx.ui.notify("Nothing to title yet.", "info");
          return;
        }
        const wasManual = state.manual;
        state.manual = false;
        const result = await generate(ctx as never);
        state.manual = wasManual;
        ctx.ui.notify(
          result.title
            ? `Title: “${result.title}” (${result.model ?? "?"}, $${(result.usage?.cost ?? 0).toFixed(4)})`
            : `Titling failed: ${result.error ?? "unknown error"}`,
          result.title ? "info" : "error",
        );
        return;
      }

      if (action && action !== "status") {
        ctx.ui.notify("Usage: /title [status|now|set <text>|auto]", "error");
        return;
      }
      ctx.ui.notify(statusText(config, state, currentTitle, last), "info");
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
  state: RefreshState,
  currentTitle: string | undefined,
  last: TitleResult | undefined,
): string {
  const lines = [
    `title: ${currentTitle ?? "(none)"}`,
    `automatic: ${config.enabled && !state.manual ? "on" : "off"}${state.manual ? " (renamed manually)" : ""}`,
    `model: ${config.model ?? "cheapest available"}`,
    `user turns: ${state.userTurns}${state.titledAtTurn !== undefined ? ` · titled at ${state.titledAtTurn}` : " · never titled"}`,
    `refresh: every ${config.refreshEvery} turns`,
  ];
  if (last?.usage) lines.push(`last request: ${last.model ?? "?"} · $${last.usage.cost.toFixed(4)}`);
  if (last?.error) lines.push(`last error: ${last.error}`);
  return lines.join("\n");
}
