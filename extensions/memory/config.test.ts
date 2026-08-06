import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_SEARCH_RESULTS,
  agentDirectory,
  defaultMemoryConfig,
  loadMemoryConfig,
  parseMemoryConfig,
  setMemoryEnabled,
} from "./config.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_SEARCH_RESULTS } from "./types.ts";

describe("memory config", () => {
  test("uses a disabled, project-scoped, confirmation-first default before opt-in", () => {
    expect(defaultMemoryConfig()).toEqual({
      enabled: false,
      defaultScope: "project",
      confirmToolMutations: true,
      maxSearchResults: DEFAULT_SEARCH_RESULTS,
    });
  });

  test("parses supported settings and ignores unknown values", () => {
    expect(parseMemoryConfig({
      enabled: true,
      defaultScope: "global",
      confirmToolMutations: false,
      maxSearchResults: 12.9,
      automaticLearning: true,
    })).toEqual({
      enabled: true,
      defaultScope: "global",
      confirmToolMutations: false,
      maxSearchResults: 12,
    });
  });

  test("clamps search result limits and falls back from malformed fields", () => {
    expect(parseMemoryConfig({ maxSearchResults: 0 }).maxSearchResults).toBe(1);
    expect(parseMemoryConfig({ maxSearchResults: 999 }).maxSearchResults).toBe(MAX_SEARCH_RESULTS);
    expect(parseMemoryConfig({ maxSearchResults: "many", defaultScope: "all" })).toEqual(defaultMemoryConfig());
  });

  test("loads config through PI agent directory and treats missing or malformed files as defaults", () => {
    const directory = `/tmp/pi-memory-config-${crypto.randomUUID()}`;
    expect(loadMemoryConfig(directory)).toEqual(defaultMemoryConfig());
  });

  test("persists only the enable toggle and preserves other configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-memory-config-"));
    const path = join(directory, CONFIG_FILE);
    try {
      await writeFile(path, JSON.stringify({
        enabled: false,
        defaultScope: "global",
        maxSearchResults: 4,
        futureSetting: { keep: true },
      }));
      expect(await setMemoryEnabled(true, directory)).toBe(path);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        enabled: true,
        defaultScope: "global",
        maxSearchResults: 4,
        futureSetting: { keep: true },
      });
      expect(loadMemoryConfig(directory)).toMatchObject({ enabled: true, defaultScope: "global", maxSearchResults: 4 });
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed rather than overwriting a malformed config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-memory-config-"));
    const path = join(directory, CONFIG_FILE);
    try {
      await writeFile(path, "{ malformed");
      await expect(setMemoryEnabled(true, directory)).rejects.toThrow("repair it instead of overwriting");
      expect(await readFile(path, "utf8")).toBe("{ malformed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("resolves the agent directory through Pi rather than hardcoding .pi", () => {
  expect(agentDirectory()).toBe(getAgentDir());
});
