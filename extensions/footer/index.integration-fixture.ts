/**
 * Runs the real footer extension against a fake pi host in its own process, so
 * the lifecycle assertions use pi's real TUI helpers instead of the partial
 * module mocks other suites install process-wide.
 */

import assert from "node:assert/strict";
import footerExtension from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const handlers = new Map<string, Handler[]>();
const pi = {
  on(name: string, handler: Handler) {
    const existing = handlers.get(name);
    if (existing) existing.push(handler);
    else handlers.set(name, [handler]);
  },
  getThinkingLevel: () => "high",
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
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 28_200, contextWindow: 258_000, percent: 6 }),
    sessionManager: {
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

// Tool-result usage (nested subagent/side-chat model calls) is included.
assert(first.includes("105 in"), `expected combined input tokens, got: ${first}`);
assert(first.includes("11 out"), `expected combined output tokens, got: ${first}`);
assert(first.includes("claude-opus-4-8 high"));
assert(first.includes("Ready"));

// New usage invalidates the cache exactly once per change.
session.branch.push({
  type: "message",
  message: { role: "assistant", usage: { input: 20, output: 2, cost: { total: 0.005 } } },
});
fire("message_end", session.ctx, { message: { role: "assistant" } });
const afterMessage = footer.render(200).join("");
assert.equal(session.scans(), 2);
assert(afterMessage.includes("125 in"), `expected refreshed totals, got: ${afterMessage}`);
footer.render(200);
assert.equal(session.scans(), 2);

fire("session_compact", session.ctx);
footer.render(200);
assert.equal(session.scans(), 3);

fire("session_tree", session.ctx);
footer.render(200);
assert.equal(session.scans(), 4);

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
// The Codex line keeps its own cells; statuses never displace them.
assert(withStatuses[0].includes("Context 94% left"), withStatuses[0]);

// A multi-line status is flattened so it cannot break the footer layout.
session.statuses.set("verify", "verifying\ntests\tnow");
assert(footer.render(200)[1].includes("verifying tests now"), footer.render(200)[1]);
session.statuses.clear();
assert.equal(footer.render(200).length, 1, "cleared statuses drop the extra line");

// The git branch is folded into the directory cell, like pi's own footer.
session.setGitBranch("main");
assert(footer.render(200)[0].includes("(main)"), footer.render(200)[0]);

// Ready/Working flips are pushed without a timer.
fire("agent_start", session.ctx);
fire("agent_settled", session.ctx);
assert.equal(session.renders(), 2);

// A checkout refreshes the branch through pi's watcher rather than a timer.
assert.equal(session.branchSubscribers(), 1, "footer must subscribe to branch changes");
session.fireBranchChange();
assert.equal(session.renders(), 3);

// Shutdown hands the built-in footer back and drops the stale TUI reference,
// so nothing renders through the replaced session context.
fire("session_shutdown", session.ctx, { reason: "resume" });
assert.equal(session.footers.length, 2);
assert.equal(session.footers.at(-1), undefined, "session_shutdown must restore pi's footer");
fire("agent_start", session.ctx);
assert.equal(session.renders(), 3, "no renders may be requested after shutdown");

// Disposing the replaced footer releases pi's branch subscription.
footer.dispose?.();
assert.equal(session.unsubscribes(), 1, "dispose must release the branch subscription");
assert.equal(session.branchSubscribers(), 0);
session.fireBranchChange();
assert.equal(session.renders(), 3, "a released subscription cannot request renders");

// A replacement session installs a fresh footer bound to the new context.
const replacement = createContext("tui");
fire("session_start", replacement.ctx);
const replacementFooter = replacement.mount();
assert(replacementFooter.render(200).join("").includes("105 in"));
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
