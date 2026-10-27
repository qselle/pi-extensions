import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SUBAGENTS_CONFIG, loadSubagentsConfig, normalizeSubagentsConfig } from "./config.ts";

test("valid wait bounds and open limits apply; invalid sections fall back", () => {
  expect(normalizeSubagentsConfig({ wait: { minimumMs: 1_000, defaultMs: 60_000, maximumMs: 600_000 }, maxOpen: 3 }, {}))
    .toEqual({ wait: { minimumMs: 1_000, defaultMs: 60_000, maximumMs: 600_000 }, maxOpen: 3 });
  expect(normalizeSubagentsConfig({ wait: { defaultMs: 120_000 } }, {}).wait.defaultMs, "partial sections keep other defaults").toBe(120_000);
  for (const wait of [{ minimumMs: 10, defaultMs: 5 }, { defaultMs: 7_200_000, maximumMs: 7_200_000 }, { minimumMs: -1 }, { defaultMs: 1.5 }]) {
    expect(normalizeSubagentsConfig({ wait }, {}).wait, JSON.stringify(wait)).toEqual(DEFAULT_SUBAGENTS_CONFIG.wait);
  }
  for (const maxOpen of [0, 17, 2.5, "4"]) expect(normalizeSubagentsConfig({ maxOpen }, {}).maxOpen).toBe(6);
});

test("PI_SUBAGENT_MAX_OPEN wins when valid", () => {
  expect(normalizeSubagentsConfig({ maxOpen: 3 }, { PI_SUBAGENT_MAX_OPEN: "8" }).maxOpen).toBe(8);
  expect(normalizeSubagentsConfig({ maxOpen: 3 }, { PI_SUBAGENT_MAX_OPEN: "99" }).maxOpen).toBe(3);
  expect(normalizeSubagentsConfig(undefined, { PI_SUBAGENT_MAX_OPEN: "2" }).maxOpen).toBe(2);
});

test("missing or malformed files use defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  try {
    const file = join(directory, "subagents.json");
    expect(loadSubagentsConfig(file, {})).toEqual(DEFAULT_SUBAGENTS_CONFIG);
    await writeFile(file, "{ not json");
    expect(loadSubagentsConfig(file, {})).toEqual(DEFAULT_SUBAGENTS_CONFIG);
    await writeFile(file, JSON.stringify({ wait: { defaultMs: 30_000 }, maxOpen: 2 }));
    expect(loadSubagentsConfig(file, {})).toEqual({ wait: { ...DEFAULT_SUBAGENTS_CONFIG.wait, defaultMs: 30_000 }, maxOpen: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
