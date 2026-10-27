import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildFocusPrompt,
  buildTitleContext,
  buildTitlePrompt,
  FOCUS_SYSTEM_PROMPT,
  lastMessageId,
  latestTitleState,
  normalizeManualTitle,
  parseFocusResponse,
  provisionalTitle,
  STATE_ENTRY,
  userRequests,
  type TitleState,
} from "./engine.ts";
import { DEFAULT_TITLE_MODEL, requestTitle, type TitleResult } from "./request.ts";
import { registerTabLink, type TabLinkOptions } from "./tab-link.ts";

const CONFIG_FILE = "session-title.json";
/** Room for the JSON turn summary, focus, and title. */
const FOCUS_TOKENS = 400;
const NO_AUTO_FLAG = "no-auto-title";
const FOOTER_BADGE_EVENT = "footer:badge";
const TITLE_BADGE_ID = "session-title";
const THINKING_LEVELS = new Set<unknown>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface SessionTitleConfig {
  enabled: boolean;
  /** First preferred "provider/model"; kept for callers that take one override. */
  model?: string;
  /** Ordered "provider/model" preferences, tried before the active session model. */
  models?: string[];
  /** Thinking level per "provider/model"; unset models think as little as they can. */
  thinking?: Record<string, ModelThinkingLevel>;
  /** "turn" (default) retitles after each finished turn; "once" names only the first request. */
  refresh?: "turn" | "once";
  /** Follow Pi names in Herdr when the tab is empty or already linked. */
  tabLink?: boolean;
}

export function agentDirectory(): string {
  return getAgentDir();
}

export function loadConfig(directory = agentDirectory()): SessionTitleConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, CONFIG_FILE), "utf8")) as Record<string, unknown>;
    const valid = (value: unknown): value is string => typeof value === "string" && value.indexOf("/") > 0;
    const models: string[] = [];
    const thinking: Record<string, ModelThinkingLevel> = {};
    // Entries are "provider/model" or { "model": "provider/model", "thinkingLevel": "minimal" }.
    for (const entry of Array.isArray(parsed?.models) ? parsed.models : []) {
      const name = typeof entry === "string" ? entry : entry?.model;
      if (!valid(name) || models.includes(name)) continue;
      models.push(name);
      if (THINKING_LEVELS.has(entry?.thinkingLevel)) thinking[name] = entry.thinkingLevel;
    }
    return {
      enabled: parsed?.enabled !== false,
      // `models` takes precedence; `model` remains a one-entry shorthand.
      model: models[0] ?? (valid(parsed?.model) ? parsed.model : undefined),
      ...(models.length > 0 ? { models } : {}),
      ...(Object.keys(thinking).length > 0 ? { thinking } : {}),
      ...(parsed?.refresh === "turn" || parsed?.refresh === "once" ? { refresh: parsed.refresh } : {}),
      ...(typeof parsed?.tabLink === "boolean" ? { tabLink: parsed.tabLink } : {}),
    };
  } catch {
    return { enabled: true };
  }
}

export interface SessionTitleOptions {
  config?: SessionTitleConfig;
  /** Defaults to process.env; child agents (PI_SUBAGENT_CHILD=1) never title automatically. */
  env?: NodeJS.ProcessEnv;
  request?: typeof requestTitle;
  tabLink?: Omit<TabLinkOptions, "enabled">;
}

type Entries = Parameters<typeof latestTitleState>[0];

interface TitleJob {
  prompt: string;
  /** First-request title from user text alone; uses the plain prompt. */
  draft?: boolean;
  /** Last message covered by a finished-turn refresh; persisted with its focus. */
  leaf?: string;
  explicit?: boolean;
}

const sameTitle = (left: string | undefined, right: string | undefined) =>
  (left ?? "").replace(/\s+/g, " ").trim().toLowerCase() === (right ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export default function sessionTitleExtension(pi: ExtensionAPI, options: SessionTitleOptions = {}): void {
  const config = options.config ?? loadConfig();
  const run = options.request ?? requestTitle;
  const env = options.env ?? process.env;
  const child = env.PI_SUBAGENT_CHILD === "1";
  const tabLink = registerTabLink(pi, { env, ...options.tabLink, enabled: config.tabLink });
  pi.registerFlag(NO_AUTO_FLAG, { description: "Disable automatic session titles for this run", type: "boolean", default: false });

  /** Set by /rename, /title set, or a name from elsewhere; /title now clears it. */
  let manualLock = false;
  /** The name this extension last set or found, so its own change events are not manual renames. */
  let managedTitle: string | undefined;
  /** Last message a refresh was started for, so repeated settles do not retitle. */
  let titledLeaf: string | undefined;
  /** One draft per session; in "once" mode it is the only automatic attempt, even when it fails. */
  let attempted = false;
  let focus: string | undefined;
  let last: TitleResult | undefined;
  let requestGeneration = 0;
  let activeRequest: AbortController | undefined;
  let titleBadge: string | undefined;
  /** A fallback route is announced when it first appears; /title status keeps the latest. */
  let fallbackRoute: string | undefined;

  const branchOf = (ctx: ExtensionContext): Entries => (ctx.sessionManager?.getBranch?.() ?? []) as Entries;
  // Names are session-wide, so ownership checks use every entry; focus follows the branch.
  const entriesOf = (ctx: ExtensionContext): Entries => (ctx.sessionManager?.getEntries?.() as Entries | undefined) ?? branchOf(ctx);
  const substantive = (entries: Entries) => userRequests(entries).some((text) => Boolean(provisionalTitle(text)));
  const refreshMode = () => config.refresh ?? "turn";
  const automatic = (): string | undefined => {
    if (child) return "off (child agent)";
    if (!config.enabled) return "off";
    if (pi.getFlag(NO_AUTO_FLAG) === true) return `off (--${NO_AUTO_FLAG})`;
    if (manualLock) return "paused (manual title; /title now resumes)";
    return undefined;
  };

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
    titledLeaf = undefined;
    last = undefined;
    const name = pi.getSessionName();
    managedTitle = name;
    // A name that differs from the last title this extension saved was set by hand.
    manualLock = Boolean(name) && !sameTitle(name, latestTitleState(entriesOf(ctx))?.title);
    focus = buildTitleContext(branchOf(ctx)).focus;
    attempted = Boolean(name) || substantive(branchOf(ctx));
  };

  const save = (state: TitleState, ctx: ExtensionContext) => {
    if (!state.focus && sameTitle(state.title, latestTitleState(entriesOf(ctx))?.title)) return;
    pi.appendEntry(STATE_ENTRY, state);
    if (state.focus) focus = state.focus;
  };

  const generate = async (ctx: ExtensionContext, job: TitleJob): Promise<TitleResult> => {
    cancelRequest();
    const generation = requestGeneration;
    const controller = new AbortController();
    activeRequest = controller;
    // Only the first title is announced; later refreshes stay quiet unless requested.
    if (!pi.getSessionName()) setTitleBadge("naming…");
    else if (job.explicit) setTitleBadge("renaming…");
    let result: TitleResult;
    try {
      result = await run({
        ctx: ctx as never,
        prompt: job.prompt,
        override: config.model,
        overrides: config.models,
        thinking: config.thinking,
        signal: controller.signal,
        ...(job.draft ? {} : { systemPrompt: FOCUS_SYSTEM_PROMPT, maxTokens: FOCUS_TOKENS, parse: parseFocusResponse }),
      });
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    if (generation !== requestGeneration) return result;
    activeRequest = undefined;
    setTitleBadge();
    last = result;
    if (result.fallback && result.fallback !== fallbackRoute) {
      ctx.ui?.notify(`Title model fallback: ${result.fallback}.`, "warning");
    }
    if (result.title) fallbackRoute = result.fallback;
    if (!result.title) return result;
    save(job.leaf && result.focus && result.turn
      ? { version: 1, title: result.title, focus: result.focus, turn: result.turn, leaf: job.leaf }
      : { version: 1, title: result.title }, ctx);
    if (!sameTitle(result.title, pi.getSessionName())) {
      managedTitle = result.title;
      pi.setSessionName(result.title);
    }
    return result;
  };

  /** Retitle from the branch: requests since the last focus, the latest answer, and the saved focus. */
  const refresh = (ctx: ExtensionContext, explicit = false): Promise<TitleResult> | undefined => {
    if (!explicit && automatic()) return undefined;
    const branch = branchOf(ctx);
    if (explicit ? userRequests(branch).length === 0 : !substantive(branch)) return undefined;
    const leaf = lastMessageId(branch);
    if (!explicit && leaf && (leaf === titledLeaf || leaf === latestTitleState(branch)?.leaf)) return undefined;
    titledLeaf = leaf;
    if (explicit) manualLock = false;
    const context = buildTitleContext(branch);
    const saved = latestTitleState(entriesOf(ctx));
    const name = pi.getSessionName();
    // A draft came from the first request alone; it is not evidence of the session focus.
    const previous = saved && !saved.focus && sameTitle(saved.title, name) ? undefined : name;
    return generate(ctx, {
      prompt: buildFocusPrompt(context, previous),
      ...(context.outcome ? { leaf } : {}),
      explicit,
    });
  };

  const setManualTitle = (title: string) => {
    cancelRequest();
    manualLock = true;
    managedTitle = title;
    attempted = true;
    pi.setSessionName(title);
  };

  pi.on("session_start", (event, ctx) => {
    load(ctx);
    // Retitle once after /reload when turns finished since the last saved title.
    if (event?.reason === "reload" && refreshMode() === "turn") void refresh(ctx);
  });
  pi.on("session_tree", (_event, ctx) => load(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    const prompt = event.prompt.trim();
    // A draft title from the first meaningful request shows while the turn runs;
    // the extraction helper is only a substantive-request check here.
    if (!prompt || automatic() || pi.getSessionName() || attempted || !provisionalTitle(prompt)) return undefined;
    if (substantive(branchOf(ctx))) return undefined;
    attempted = true;
    void generate(ctx, { prompt: buildTitlePrompt([prompt]), draft: true });
    return undefined;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (refreshMode() === "turn") void refresh(ctx);
  });

  pi.on("session_info_changed", (event) => {
    // Pi re-emits names it already knows; only a different name is a rename.
    if (!event.name || sameTitle(event.name, managedTitle)) return;
    managedTitle = event.name;
    manualLock = true;
    cancelRequest();
  });

  pi.registerCommand("title", {
    description: "Session title: /title [status|now|set <text>|tab]",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "now", "set", "tab", "tab status", "tab link", "tab auto", "tab off"]
        .filter((value) => value.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [command = "", ...rest] = args.trim().split(/\s+/);
      const action = command.toLowerCase();

      if (action === "tab") {
        await tabLink.command(rest.join(" "), ctx);
        return;
      }

      if (action === "set") {
        const title = normalizeManualTitle(rest.join(" "));
        if (!title) {
          ctx.ui.notify("Usage: /title set <text>", "error");
          return;
        }
        setManualTitle(title);
        ctx.ui.notify(`Title set to “${title}”.`, "info");
        return;
      }

      if (action === "now") {
        const pending = refresh(ctx, true);
        if (!pending) {
          ctx.ui.notify("Nothing to title yet.", "info");
          return;
        }
        const generation = requestGeneration;
        const result = await pending;
        if (generation !== requestGeneration) return;
        ctx.ui.notify(
          result.title
            ? `Title: “${result.title}” (${result.model ?? "?"}, $${(result.usage?.cost ?? 0).toFixed(4)})`
            : `Titling failed: ${result.error ?? "unknown error"}`,
          result.title ? "info" : "error",
        );
        return;
      }

      if (action && action !== "status") {
        ctx.ui.notify("Usage: /title [status|now|set <text>|tab]", "error");
        return;
      }
      const status = statusText({ config, title: pi.getSessionName(), automatic: automatic(), focus, last });
      ctx.ui.notify(`${status}\n${tabLink.status()}`, "info");
    },
  });

  pi.registerCommand("rename", {
    description: "Set a session name directly: /rename <text> (or open a name prompt)",
    handler: async (args, ctx) => {
      let raw: string | undefined = args.trim();
      if (!raw) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Usage: /rename <text>", "info");
          return;
        }
        const generation = requestGeneration;
        raw = await ctx.ui.input("Session name", pi.getSessionName() ?? "Name this session");
        if (generation !== requestGeneration || raw === undefined) return;
      }
      const title = normalizeManualTitle(raw);
      if (!title) return;
      setManualTitle(title);
      ctx.ui.notify(`Title set to “${title}”.`, "info");
    },
  });

  pi.on("session_shutdown", () => cancelRequest());
}

export interface StatusInput {
  config: SessionTitleConfig;
  title?: string;
  /** Why automatic titling is inactive; undefined when it runs. */
  automatic?: string;
  focus?: string;
  last?: TitleResult;
}

export function statusText({ config, title, automatic, focus, last }: StatusInput): string {
  const lines = [
    `title: ${title ?? "(none)"}`,
    `automatic: ${automatic ?? ((config.refresh ?? "turn") === "turn" ? "after each turn" : "first request only")}`,
    `model: ${[...modelOrder(config), "active session model"].join(" → ")}`,
  ];
  if (focus) lines.push(`focus: ${focus}`);
  if (last?.usage) lines.push(`last request: ${last.model ?? "?"} · $${last.usage.cost.toFixed(4)}`);
  if (last?.fallback) lines.push(`last fallback: ${last.fallback}`);
  if (last?.error) lines.push(`last error: ${last.error}`);
  return lines.join("\n");
}

function modelOrder(config: SessionTitleConfig): string[] {
  const configured = config.models ?? (config.model ? [config.model] : []);
  return configured.length > 0 ? configured : [`${DEFAULT_TITLE_MODEL} (if authenticated)`];
}
