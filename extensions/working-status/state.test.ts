import { expect, test } from "bun:test";
import { WorkingState, elapsed, toolActivity, toolLabel } from "./state.ts";

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
  expect(state.label(0)).toBe("Running read ×2, bash +1 · 0s");
  expect(toolLabel("bash\n\x07")).toBe("bash");
  expect(toolLabel("x".repeat(100))).toHaveLength(28);
});

test("activity targets show file context without leaking command arguments", () => {
  expect(toolActivity("read", { path: "/work/project/src/index.ts" })).toBe("read src/index.ts");
  expect(toolActivity("edit", { path: "C:\\work\\src\\main.ts", oldText: "secret" })).toBe("edit src/main.ts");
  expect(toolActivity("bash", { command: "curl -H 'Authorization: secret' https://example.com/private" })).toBe("bash: curl");
  expect(toolActivity("bash", { command: "SECRET=value bun test" })).toBe("bash");
  expect(toolActivity("bash", { command: "private-command secret" })).toBe("bash");
  expect(toolActivity("web_search", { query: "confidential" })).toBe("web_search");
  expect(toolActivity("read", { path: "\x1b]0;hidden\x07src/\x1b[31mfile.ts\x1b[0m\n" })).toBe("read src/file.ts");
  expect([...toolActivity("write", { path: `src/${"界".repeat(80)}.ts` })]).toHaveLength(38);
});

test("overflow counts calls, including repeated tools that are not shown", () => {
  const state = new WorkingState();
  state.start(0);
  ["read", "bash", "write", "write", "edit"].forEach((name, i) => state.tools.set(String(i), name));
  expect(state.label(0)).toBe("Running read, bash +3 · 0s");
});
