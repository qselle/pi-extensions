import { expect, test } from "bun:test";
import type { AgentSnapshot } from "./coordinator.ts";
import { collapsedResult, headlineSuffix, hiddenLinesMarker } from "./preview.ts";

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "a1",
    name: "scout",
    task: "Audit the parser",
    contextMode: "fresh",
    status: "completed",
    cwd: "/work",
    startedAt: 0,
    output: "",
    activity: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    ...overrides,
  } as AgentSnapshot;
}

test("wait headlines state the outcome and how many children remain running", () => {
  const running = agent({ id: "a2", status: "running" });

  expect(headlineSuffix({ action: "wait", agents: [agent(), running] })).toBe(" · 1 still running");
  expect(headlineSuffix({ action: "wait", agents: [running, agent({ id: "a3", status: "starting" })] }))
    .toBe(" · 2 still running");
  expect(headlineSuffix({ action: "wait", agents: [agent(), running], timedOut: true }))
    .toBe(" · timed out · 1 still running");
  expect(headlineSuffix({ action: "wait", agents: [agent(), running], interrupted: true, timedOut: true }))
    .toBe(" · interrupted · 1 still running");
  expect(headlineSuffix({ action: "wait", agents: [agent()] })).toBe(" · all settled");
});

test("non-wait headlines only report an explicit outcome", () => {
  expect(headlineSuffix({ action: "spawn", agents: [agent({ status: "running" })] })).toBe("");
  expect(headlineSuffix({ action: "close", agents: [agent()], interrupted: true })).toBe(" · interrupted");
  expect(headlineSuffix({ action: "list", agents: [agent({ status: "running" })], timedOut: true })).toBe(" · timed out");
});

test("collapsed results keep the tail of the output and report what is hidden", () => {
  const output = ["intro", "", "step one", "step two", "step three", "step four", "conclusion"].join("\n");

  expect(collapsedResult(output)).toEqual({
    lines: ["step two", "step three", "step four", "conclusion"],
    hidden: 2,
  });
  expect(hiddenLinesMarker(2, "Ctrl+O")).toBe("… +2 earlier lines (Ctrl+O for full output)");
  expect(hiddenLinesMarker(1, "Ctrl+O")).toBe("… +1 earlier line (Ctrl+O for full output)");
  // The hint names whatever key the user bound to app.tools.expand.
  expect(hiddenLinesMarker(3, "Ctrl+E")).toBe("… +3 earlier lines (Ctrl+E for full output)");
});

test("short results are shown in full without hiding anything", () => {
  expect(collapsedResult("done\r\n\n")).toEqual({ lines: ["done"], hidden: 0 });
  expect(collapsedResult("   \n\t\n")).toEqual({ lines: [], hidden: 0 });
  expect(collapsedResult("a\nb\nc", 3)).toEqual({ lines: ["a", "b", "c"], hidden: 0 });
  // The hidden-lines marker occupies one of the requested rows.
  expect(collapsedResult("a\nb\nc\nd", 3)).toEqual({ lines: ["c", "d"], hidden: 2 });
});

test("very long single lines are compacted instead of flooding the preview", () => {
  const { lines, hidden } = collapsedResult(`${"x".repeat(500)}\ttail`);

  expect(hidden).toBe(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveLength(200);
  expect(lines[0].endsWith("…")).toBe(true);
});
