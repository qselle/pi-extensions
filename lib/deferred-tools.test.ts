import { expect, test } from "bun:test";
import { deferredTools } from "./deferred-tools.ts";
test("activation preserves unrelated tools, original exclusions and later manual changes", () => {
  let active = ["read", "stop", "list"];
  const controls = deferredTools({ getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; } } as any, ["stop", "list", "never-selected"]);
  controls.initialize();
  expect(active).toEqual(["read"]);
  active.push("unrelated");
  controls.activate();
  expect(active).toEqual(["read", "unrelated", "stop", "list"]);
  active = active.filter(name => name !== "stop");
  controls.activate();
  expect(active).toEqual(["read", "unrelated", "list"]);
});
test("an alias can remain dormant while follow-up controls activate", () => {
  let active = ["bash", "job_start", "job_wait"];
  const controls = deferredTools({ getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; } } as any, ["job_start", "job_wait"]);
  controls.initialize(); controls.activate(["job_wait"]);
  expect(active).toEqual(["bash", "job_wait"]);
});
