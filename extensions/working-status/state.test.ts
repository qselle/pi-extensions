import { expect, test } from "bun:test";
import { WorkingState, elapsed, toolLabel } from "./state.ts";

test("elapsed handles boundaries and ignores backward clock movement", () => {
  expect([-1, 999, 60000, 3599000, 3600000].map(elapsed)).toEqual(["0s", "0s", "1m 0s", "59m 59s", "1h 0m"]);
});

test("parallel tool completion retains the remaining work and total run duration", () => {
  const state = new WorkingState();
  expect(state.label(100)).toBeUndefined();
  state.start(100);
  state.tools.set("a", "read");
  state.tools.set("b", "bash");
  expect(state.label(2100)).toBe("Running read, bash · 2s");
  state.tools.delete("a");
  expect(state.label(61000)).toBe("Running bash · 1m 0s");
  state.tools.clear();
  state.phase = "Writing";
  expect(state.label(62100)).toBe("Writing · 1m 2s");
  state.reset();
  expect(state.label(63100)).toBeUndefined();
});

test("tool summary is deduplicated and bounded", () => {
  const state = new WorkingState();
  state.start(0);
  ["read", "read", "bash", "write"].forEach((name, i) => state.tools.set(String(i), name));
  expect(state.label(0)).toBe("Running read, bash +1 · 0s");
  expect(toolLabel("bash\n\x07")).toBe("bash");
  expect(toolLabel("x".repeat(100))).toHaveLength(28);
});
