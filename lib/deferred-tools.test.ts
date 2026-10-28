import { expect, test } from "bun:test";
import { deferredTools } from "./deferred-tools.ts";

const host = (initial: string[]) => {
  const state = { active: initial };
  return { state, pi: { getActiveTools: () => state.active, setActiveTools: (next: string[]) => { state.active = next; } } as any };
};

test("activation appends without reordering and respects later manual changes", () => {
  const { state, pi } = host(["read"]);
  const controls = deferredTools(pi, ["stop", "list"]);
  controls.initialize();
  state.active.push("unrelated");
  controls.activate();
  expect(state.active).toEqual(["read", "unrelated", "stop", "list"]);
  state.active = state.active.filter(name => name !== "stop");
  controls.activate();
  expect(state.active).toEqual(["read", "unrelated", "list"]);
});

test("an alias can remain dormant while follow-up controls activate", () => {
  const { state, pi } = host(["bash"]);
  const controls = deferredTools(pi, ["job_start", "job_wait"]);
  controls.initialize(); controls.activate(["job_wait"]);
  expect(state.active).toEqual(["bash", "job_wait"]);
});

test("controls a resumed branch restored stay active and are never re-added after removal", () => {
  const { state, pi } = host(["read", "update_goal"]);
  const controls = deferredTools(pi, ["update_goal", "get_goal"]);
  controls.initialize();
  expect(state.active).toEqual(["read", "update_goal"]);
  state.active = ["read"];
  controls.activate();
  expect(state.active).toEqual(["read", "get_goal"]);
});

test("tree navigation to a branch without the controls makes them pending again", () => {
  const { state, pi } = host(["read"]);
  const controls = deferredTools(pi, ["update_goal"]);
  controls.initialize(); controls.activate();
  state.active = ["read"];
  controls.initialize(); controls.activate();
  expect(state.active).toEqual(["read", "update_goal"]);
});
