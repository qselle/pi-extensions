import { describe, expect, test } from "bun:test";
import { deferredTools } from "./deferred-tools.ts";

const host = (initial: string[]) => {
  const state = { active: initial };
  return { state, pi: { getActiveTools: () => state.active, setActiveTools: (next: string[]) => { state.active = next; } } as any };
};

describe("controls registered inactive", () => {
  const options = { registeredInactive: true };

  test("activation appends without reordering and respects later manual changes", () => {
    const { state, pi } = host(["read"]);
    const controls = deferredTools(pi, ["stop", "list"], options);
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
    const controls = deferredTools(pi, ["job_start", "job_wait"], options);
    controls.initialize(); controls.activate(["job_wait"]);
    expect(state.active).toEqual(["bash", "job_wait"]);
  });

  test("controls a resumed branch restored stay active and are never re-added after removal", () => {
    const { state, pi } = host(["read", "update_goal"]);
    const controls = deferredTools(pi, ["update_goal", "get_goal"], options);
    controls.initialize();
    expect(state.active).toEqual(["read", "update_goal"]);
    state.active = ["read"];
    controls.activate();
    expect(state.active).toEqual(["read", "get_goal"]);
  });

  test("tree navigation to a branch without the controls makes them pending again", () => {
    const { state, pi } = host(["read"]);
    const controls = deferredTools(pi, ["update_goal"], options);
    controls.initialize(); controls.activate();
    state.active = ["read"];
    controls.initialize(); controls.activate();
    expect(state.active).toEqual(["read", "update_goal"]);
  });
});

describe("controls registered active (legacy)", () => {
  test("are withheld at session start and restored only on activation", () => {
    const { state, pi } = host(["read", "stop", "list"]);
    const controls = deferredTools(pi, ["stop", "list", "never-selected"]);
    controls.initialize();
    expect(state.active).toEqual(["read"]);
    state.active.push("unrelated");
    controls.activate();
    expect(state.active).toEqual(["read", "unrelated", "stop", "list"]);
    state.active = state.active.filter(name => name !== "stop");
    controls.activate();
    expect(state.active).toEqual(["read", "unrelated", "list"]);
  });

  test("branch restoration retains tools already withheld by this instance", () => {
    const { state, pi } = host(["read", "update_goal"]);
    const controls = deferredTools(pi, ["update_goal", "never-selected"]);
    controls.initialize();
    controls.initialize();
    controls.activate();
    expect(state.active).toEqual(["read", "update_goal"]);
  });
});
