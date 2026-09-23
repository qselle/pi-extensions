import { expect, test } from "bun:test";
import workingStatusExtension from "./index.ts";

function harness(mode = "tui") {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const indicators: any[] = [];
  const notifications: string[] = [];
  const messages: Array<string | undefined> = [];
  const thinkingLabels: Array<string | undefined> = [];
  const ctx = { mode, isIdle: () => true, sessionManager: { getBranch: () => entries }, ui: {
    setWorkingMessage: (s?: string) => messages.push(s),
    setHiddenThinkingLabel: (s?: string) => thinkingLabels.push(s),
    setWorkingIndicator: (options?: unknown) => indicators.push(options),
    notify: (text: string) => notifications.push(text),
  } };
  workingStatusExtension({ on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as never);
  return { messages, indicators, entries, notifications, thinkingLabels, ctx, command: (args: string) => commands.get("working-style").handler(args, ctx), fire: (name: string, event = {}) => handlers.get(name)?.(event, ctx) };
}

test("public events update phases, coalesce tokens, and release the working row", () => {
  const h = harness();
  try {
    h.fire("session_start");
    expect(h.messages).toEqual([]);
    expect(h.thinkingLabels).toEqual([]);
    h.fire("agent_start");
    expect(h.messages.at(-1)).toBe("Waiting for model · 0s");
    h.fire("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
    const count = h.messages.length;
    h.fire("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
    expect(h.messages).toHaveLength(count);
    h.fire("tool_execution_start", { toolCallId: "a", toolName: "bash" });
    h.fire("tool_execution_start", { toolCallId: "b", toolName: "read" });
    h.fire("tool_execution_end", { toolCallId: "b" });
    expect(h.messages.at(-1)).toBe("Running bash · 0s");
    h.fire("agent_settled");
    expect(h.messages.at(-1)).toBeUndefined();
    const settledCount = h.messages.length;
    h.fire("tool_execution_end", { toolCallId: "a" });
    h.fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
    expect(h.messages).toHaveLength(settledCount);
    h.fire("agent_start");
    expect(h.messages.at(-1)).toBe("Waiting for model · 0s");
  } finally { h.fire("session_shutdown"); }
});

test("RPC and JSON sessions never touch interactive UI", () => {
  for (const mode of ["rpc", "json"]) {
    const h = harness(mode);
    h.fire("agent_start");
    h.fire("tool_execution_start", { toolCallId: "a", toolName: "read" });
    h.fire("agent_settled");
    h.fire("session_shutdown");
    expect(h.messages).toEqual([]);
    expect(h.indicators).toEqual([]);
    expect(h.thinkingLabels).toEqual([]);
  }
});

test("tool events show safe targets and preserve concurrent identical calls", () => {
  const h = harness();
  try {
    h.fire("agent_start");
    h.fire("tool_execution_start", { toolCallId: "a", toolName: "read", args: { path: "/repo/src/index.ts" } });
    h.fire("tool_execution_start", { toolCallId: "b", toolName: "read", args: { path: "/repo/src/index.ts" } });
    h.fire("tool_execution_start", { toolCallId: "c", toolName: "bash", args: { command: "curl -H 'secret' https://private.example" } });
    expect(h.messages.at(-1)).toBe("Running read src/index.ts ×2, bash: curl · 0s");
    h.fire("tool_execution_end", { toolCallId: "a" });
    expect(h.messages.at(-1)).toBe("Running read src/index.ts, bash: curl · 0s");
    h.fire("tool_execution_end", { toolCallId: "b" });
    expect(h.messages.at(-1)).toBe("Running bash: curl · 0s");
  } finally { h.fire("session_shutdown"); }
});

test("working style persists, switches live, and restores native on settlement", async () => {
  const h = harness();
  try {
    await h.command("static");
    expect(h.indicators).toHaveLength(0);
    h.fire("agent_start");
    expect(h.indicators.at(-1)).toEqual({ frames: ["●"] });
    await h.command("pulse");
    expect(h.indicators.at(-1)).toEqual({ frames: ["·", "•", "●", "•"], intervalMs: 240 });
    await h.command("text");
    expect(h.indicators.at(-1)).toEqual({ frames: [] });
    expect(h.messages.at(-1)).toBe("Waiting for model · 0s");
    h.fire("agent_settled");
    expect(h.indicators.at(-1)).toBeUndefined();
    h.fire("session_start");
    h.fire("agent_start");
    expect(h.indicators.at(-1)).toEqual({ frames: [] });
    expect(h.entries).toHaveLength(3);
  } finally { h.fire("session_shutdown"); }
});

test("branch navigation clears the previous style and stale working state", async () => {
  const h = harness();
  try {
    await h.command("static"); h.fire("agent_start");
    h.fire("tool_execution_start", { toolCallId: "old", toolName: "bash" });
    h.entries.length = 0;
    h.entries.push({ type: "custom", customType: "working-status-style", data: { version: 1, style: "unrecognized" } });
    h.fire("session_tree");
    expect(h.indicators.at(-1)).toBeUndefined();
    h.fire("agent_start");
    expect(h.indicators.at(-1)).toEqual({ frames: ["·", "•", "●", "•"], intervalMs: 240 });
    expect(h.messages.at(-1)).toBe("Waiting for model · 0s");
    const count = h.entries.length;
    await h.command("invalid"); await h.command("");
    expect(h.entries).toHaveLength(count);
    expect(h.notifications.at(-1)).toContain("Working style: pulse");
  } finally { h.fire("session_shutdown"); }
});


test("thinking presentation remains owned by the host throughout the lifecycle", () => {
  const h = harness();
  h.fire("session_start");
  h.fire("agent_start");
  h.fire("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
  h.fire("agent_settled");
  h.fire("session_tree");
  h.fire("session_shutdown");
  expect(h.thinkingLabels).toEqual([]);
});
