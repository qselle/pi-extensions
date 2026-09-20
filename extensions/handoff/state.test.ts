import { expect, test } from "bun:test";
import { checkpoint, contextText, decodeCheckpoint, HANDOFF_ENTRY, latestCheckpoint, latestUser, workflowState } from "./state.ts";

test("bounded checkpoint strips controls and known secrets", () => {
  const value = checkpoint("Objective: \x1b[31mfinish\x1b[0m secret-value", "Continue", "session", "user", ["secret-value"]);
  expect(value.summary).toBe("Objective: finish [redacted]");
  expect(decodeCheckpoint(value)).toEqual(value);
  expect(() => checkpoint(" ", "", "session")).toThrow();
  expect(() => checkpoint("x".repeat(20001), "", "session")).toThrow();
  expect(() => checkpoint("x", "x".repeat(2001), "session")).toThrow();
  expect(decodeCheckpoint({ ...value, createdAt: NaN })).toBeUndefined();
  expect(contextText(value)).toContain("not a new instruction or proof");
});
test("loads the latest valid checkpoint and user on the current branch", () => {
  const first = checkpoint("first", "", "session"); const second = checkpoint("second", "", "session");
  const entries = [{ type: "message", id: "u1", message: { role: "user" } }, { type: "custom", customType: HANDOFF_ENTRY, data: first }, { type: "custom", customType: HANDOFF_ENTRY, data: second }, { type: "custom", customType: HANDOFF_ENTRY, data: {} }];
  expect(latestCheckpoint(entries)).toEqual(second);
  expect(latestUser(entries)).toBe("u1");
});
test("carries only validated goal and plan state, including explicit clears", () => {
  const goal = { version: 2, goal: null }; const plan = { version: 1, plan: { items: [], updatedAt: 100 } };
  expect(workflowState([{ type: "custom", customType: "goal-state", data: goal }, { type: "custom", customType: "plan-state", data: plan }, { type: "custom", customType: "goal-state", data: {} }, { type: "custom", customType: "background-job-lifecycle", data: { pid: 1 } }, { type: "custom", customType: "secret", data: "private" }])).toEqual([{ type: "goal-state", data: goal }, { type: "plan-state", data: plan }]);
});
