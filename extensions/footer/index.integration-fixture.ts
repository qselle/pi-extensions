/**
 * Runs the real footer extension against a fake pi host in its own process, so
 * the lifecycle assertions use pi's real TUI helpers instead of the partial
 * module mocks other suites install process-wide.
 */

import assert from "node:assert/strict";
import footerExtension from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const handlers = new Map<string, Handler[]>();
const eventHandlers = new Map<string, Array<(value: unknown) => void>>();
let sessionName = "Footer refresh";
const events = {
  on(name: string, handler: (value: unknown) => void) {
    const existing = eventHandlers.get(name);
    if (existing) existing.push(handler);
    else eventHandlers.set(name, [handler]);
  },
  emit(name: string, value: unknown) {
    for (const handler of eventHandlers.get(name) ?? []) handler(value);
  },
};
const pi = {
  on(name: string, handler: Handler) {
    const existing = handlers.get(name);
    if (existing) existing.push(handler);
    else handlers.set(name, [handler]);
  },
  events,
  getThinkingLevel: () => "high",
  getSessionName: () => sessionName,
} as never;

function fire(name: string, ctx: unknown, event: unknown = {}): void {
  for (const handler of handlers.get(name) ?? []) handler(event, ctx);
}

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
};

interface FooterComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

function createContext(mode: string) {
  let branchScans = 0;
  let renders = 0;
  let idle = true;
  const titles: string[] = [];
  const footers: Array<((tui: unknown, theme: unknown, data: unknown) => FooterComponent) | undefined> = [];
  const branch: unknown[] = [
    { type: "message", message: { role: "assistant", usage: { input: 100, output: 10, cost: { total: 0.02 } } } },
    { type: "message", message: { role: "toolResult", usage: { input: 5, output: 1, cost: { total: 0.001 } } } },
    { type: "message", message: { role: "user" } },
  ];
  const tui = { requestRender: () => { renders++; } };
  // Mirrors pi's ReadonlyFooterDataProvider.
  const statuses = new Map<string, string>();
  const branchCallbacks = new Set<() => void>();
  let unsubscribes = 0;
  let gitBranch: string | null = null;
  const footerData = {
    getGitBranch: () => gitBranch,
    getExtensionStatuses: (): ReadonlyMap<string, string> => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: (callback: () => void) => {
      branchCallbacks.add(callback);
      return () => {
        unsubscribes++;
        branchCallbacks.delete(callback);
      };
    },
  };
  const ctx = {
    mode,
    cwd: "/work/project",
    model: { id: "claude-opus-4-8" },
    isIdle: () => idle,
    getContextUsage: () => ({ tokens: 28_200, contextWindow: 258_000, percent: 6 }),
    sessionManager: {
      getLeafId: () => String(branch.length),
      getBranch: () => {
        branchScans++;
        return branch;
      },
    },
    ui: {
      theme,
      setFooter: (factory?: (tui: unknown, theme: unknown, data: unknown) => FooterComponent) => {
        footers.push(factory);
      },
      setTitle: (title: string) => { titles.push(title); },
    },
  };
  const mount = (): FooterComponent => {
    const factory = footers.at(-1);
    assert(factory, "expected a footer factory to be installed");
    return factory(tui, theme, footerData);
  };
  return {
    ctx,
    branch,
    mount,
    footers,
    statuses,
    titles,
    setIdle: (value: boolean) => { idle = value; },
    setGitBranch: (name: string | null) => { gitBranch = name; },
    fireBranchChange: () => { for (const callback of branchCallbacks) callback(); },
    branchSubscribers: () => branchCallbacks.size,
    unsubscribes: () => unsubscribes,
    scans: () => branchScans,
    renders: () => renders,
  };
}

footerExtension(pi);

// TUI sessions install a footer; the branch is scanned once and reused per frame.
const session = createContext("tui");
fire("session_start", session.ctx);
assert.equal(session.footers.length, 1);

const footer = session.mount();
const first = footer.render(200).join("");
footer.render(200);
footer.render(200);
assert.equal(session.scans(), 1, "render must not rescan the branch every frame");

// Identity, state, compact usage, and the idle terminal title are present.
assert(first.includes("Footer refresh"), first);
assert(first.includes("claude-opus-4-8 high"), first);
assert(first.includes("● ready"), first);
assert(first.includes("ctx 94% left"), first);
// Tool-result usage (nested subagent/side-chat model calls) is included.
assert(first.includes("↓105"), `expected combined input tokens, got: ${first}`);
assert(first.includes("↑11"), `expected combined output tokens, got: ${first}`);
assert.equal(session.titles.at(-1), "π Footer refresh · project");

// New usage invalidates the cache exactly once per change.
session.branch.push({
  type: "message",
  message: { role: "assistant", usage: { input: 20, output: 2, cost: { total: 0.005 } } },
});
fire("message_end", session.ctx, { message: { role: "assistant" } });
const afterMessage = footer.render(200).join("");
assert.equal(session.scans(), 2);
assert(afterMessage.includes("↓125"), `expected refreshed totals, got: ${afterMessage}`);
footer.render(200);
assert.equal(session.scans(), 2);

fire("session_compact", session.ctx);
footer.render(200);
assert.equal(session.scans(), 3);

fire("session_tree", session.ctx);
footer.render(200);
assert.equal(session.scans(), 4);

// Idle cache warming produces a usage entry without an assistant event.
session.branch.push({ type: "usage", kind: "cache_warm", usage: { input: 7, output: 1, cost: { total: 0.004 } } });
const afterWarm = footer.render(200).join("");
assert(afterWarm.includes("↓132"), afterWarm);
assert.equal(session.scans(), 5);
footer.render(200);
assert.equal(session.scans(), 5);

// Extension statuses (ctx.ui.setStatus) render on their own line, sorted by key,
// so replacing pi's footer no longer hides them.
assert.equal(footer.render(200).length, 1, "no statuses means no extra line");
session.statuses.set("verify", "verifying tests…");
session.statuses.set("subagents-usage", "agents ↑12k ↓850 $0.0421");
const withStatuses = footer.render(200);
assert.equal(withStatuses.length, 2, "extension statuses need their own line");
assert(withStatuses[1].includes("agents ↑12k ↓850 $0.0421"), withStatuses[1]);
assert(withStatuses[1].includes("verifying tests…"), withStatuses[1]);
assert(
  withStatuses[1].indexOf("agents") < withStatuses[1].indexOf("verifying"),
  `statuses must be sorted by key: ${withStatuses[1]}`,
);
// The main line keeps its own cells; statuses never displace them.
assert(withStatuses[0].includes("ctx 94% left"), withStatuses[0]);

// A multi-line status is flattened so it cannot break the footer layout.
session.statuses.set("verify", "verifying\ntests\tnow");
assert(footer.render(200)[1].includes("verifying tests now"), footer.render(200)[1]);
session.statuses.clear();
assert.equal(footer.render(200).length, 1, "cleared statuses drop the extra line");

// Git identity is anchored on the right, separate from the information rail.
session.setGitBranch("main");
const withBranch = footer.render(200)[0];
assert(withBranch.endsWith("/work/project · main"), withBranch);

// Optional extensions can publish compact first-line badges without consuming
// the transient status row. Updates replace by id and empty text removes them.
const beforeBadgeRender = session.renders();
events.emit("footer:badge", { id: "priority", text: "fast", order: 10 });
assert.equal(session.renders(), beforeBadgeRender + 1);
assert(footer.render(200)[0].includes("[fast]"), footer.render(200)[0]);
events.emit("footer:badge", { id: "priority" });
assert(!footer.render(200)[0].includes("[fast]"), footer.render(200)[0]);

// Activity updates both the footer and terminal title. Attention overrides win
// until their owning source clears them, then activity resumes.
const beforeLifecycleRenders = session.renders();
session.setIdle(false);
fire("agent_start", session.ctx);
assert(footer.render(200)[0].includes("● working"), footer.render(200)[0]);
assert(/^⠋ π Footer refresh · project$/.test(session.titles.at(-1) ?? ""), session.titles.at(-1) ?? "missing title");
events.emit("terminal-title:override", { source: "questions", title: "❓ Input needed" });
assert.equal(session.titles.at(-1), "❓ Input needed");
events.emit("terminal-title:override", { source: "questions" });
assert((session.titles.at(-1) ?? "").includes("π Footer refresh · project"));
session.setIdle(true);
fire("agent_settled", session.ctx);
assert.equal(session.titles.at(-1), "π Footer refresh · project");
assert.equal(session.renders(), beforeLifecycleRenders + 2);

// Session renames are reflected without replacing the footer component.
sessionName = "Footer polish";
fire("session_info_changed", session.ctx, { name: sessionName });
assert(footer.render(200)[0].includes("Footer polish"), footer.render(200)[0]);
assert.equal(session.titles.at(-1), "π Footer polish · project");

// A checkout refreshes the branch through pi's watcher rather than a timer.
assert.equal(session.branchSubscribers(), 1, "footer must subscribe to branch changes");
const beforeBranchRender = session.renders();
session.fireBranchChange();
assert.equal(session.renders(), beforeBranchRender + 1);

// Shutdown hands the built-in footer back and drops the stale TUI reference,
// so nothing renders through the replaced session context.
fire("session_shutdown", session.ctx, { reason: "resume" });
assert.equal(session.footers.length, 2);
assert.equal(session.footers.at(-1), undefined, "session_shutdown must restore pi's footer");
assert.equal(session.titles.at(-1), "pi", "session shutdown must release the terminal title");
const rendersAfterShutdown = session.renders();
fire("agent_start", session.ctx);
assert.equal(session.renders(), rendersAfterShutdown, "no renders may be requested after shutdown");

// Disposing the replaced footer releases pi's branch subscription.
footer.dispose?.();
assert.equal(session.unsubscribes(), 1, "dispose must release the branch subscription");
assert.equal(session.branchSubscribers(), 0);
session.fireBranchChange();
assert.equal(session.renders(), rendersAfterShutdown, "a released subscription cannot request renders");

// A replacement session installs a fresh footer bound to the new context.
const replacement = createContext("tui");
fire("session_start", replacement.ctx);
const replacementFooter = replacement.mount();
assert(replacementFooter.render(200).join("").includes("↓105"));
assert.equal(replacement.scans(), 1);

// dispose() releases the TUI reference when pi swaps footers itself.
replacementFooter.dispose?.();
fire("agent_start", replacement.ctx);
assert.equal(replacement.renders(), 0);

// Non-interactive modes never install a footer.
const headless = createContext("json");
fire("session_start", headless.ctx);
assert.equal(headless.footers.length, 0);
fire("session_shutdown", headless.ctx, { reason: "quit" });
assert.equal(headless.footers.length, 0, "headless shutdown must not touch the footer");

console.log("footer lifecycle verified");
