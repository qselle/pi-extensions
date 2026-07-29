import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStore,
  findProjectRoot,
  normalizeMemoryText,
  projectStoreFilename,
} from "./store.ts";
import { MAX_SEARCH_SNIPPET_CHARS } from "./types.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
  temporaryDirectories.push(base);
  const root = join(base, "agent", "memory");
  const projectA = join(base, "work", "alpha");
  const projectB = join(base, "work", "beta");
  await mkdir(join(projectA, ".git"), { recursive: true });
  await mkdir(join(projectB, ".git"), { recursive: true });
  let clock = new Date("2026-01-02T03:04:05.000Z");
  let ids = 0;
  const make = (cwd: string, sessionId = "session-1") => new MemoryStore({
    root,
    cwd,
    sessionId,
    now: () => new Date(clock),
    newId: () => `m_test-${++ids}`,
  });
  return {
    base,
    root,
    projectA,
    projectB,
    make,
    advanceDays(days: number) {
      clock = new Date(clock.getTime() + days * 24 * 60 * 60 * 1_000);
    },
  };
}

describe("project identity and paths", () => {
  test("uses the nearest git ancestor and a generated traversal-safe store name", async () => {
    const box = await sandbox();
    const nested = join(box.projectA, "packages", "api");
    await mkdir(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(box.projectA);
    expect(projectStoreFilename(box.projectA)).toMatch(/^alpha-[a-f0-9]{12}\.json$/);
    expect(projectStoreFilename(join(box.base, "..", "odd project"))).not.toContain("..");
  });

  test("falls back to the supplied cwd outside a git checkout", async () => {
    const box = await sandbox();
    const plain = join(box.base, "plain");
    await mkdir(plain);
    expect(findProjectRoot(plain)).toBe(plain);
  });
});

describe("memory persistence and scopes", () => {
  test("persists explicit provenance and reloads records across store instances", async () => {
    const box = await sandbox();
    const first = box.make(join(box.projectA, "src"), "session-a");
    const saved = await first.remember({
      text: "Run bun test before declaring this repository complete.",
      scope: "project",
      tags: ["Tests", " workflow "],
    });

    expect(saved.created).toBe(true);
    expect(saved.record).toMatchObject({
      id: "m_test-1",
      scope: "project",
      projectRoot: box.projectA,
      tags: ["tests", "workflow"],
      source: { kind: "explicit", cwd: join(box.projectA, "src"), sessionId: "session-a" },
    });

    const restored = box.make(box.projectA, "session-b");
    expect(await restored.read(saved.record.id)).toMatchObject({
      text: saved.record.text,
      source: { sessionId: "session-a" },
    });
    const file = JSON.parse(await readFile(saved.path, "utf8"));
    expect(file.version).toBe(1);
    expect(file.scope).toEqual({ kind: "project", root: box.projectA });
  });

  test("isolates project records while intentionally sharing global records", async () => {
    const box = await sandbox();
    const alpha = box.make(box.projectA);
    const beta = box.make(box.projectB);
    const project = await alpha.remember({ text: "alpha-only deployment needle", scope: "project" });
    const global = await alpha.remember({ text: "global communication needle", scope: "global" });

    expect((await alpha.search({ query: "needle" })).map((entry) => entry.id)).toEqual([
      project.record.id,
      global.record.id,
    ]);
    expect((await beta.search({ query: "needle" })).map((entry) => entry.id)).toEqual([global.record.id]);
    expect(await beta.read(project.record.id)).toBeUndefined();
    expect(await beta.read(global.record.id)).toMatchObject({ scope: "global" });

    const status = await beta.status();
    expect(status.scopes.find((scope) => scope.scope === "project")?.active).toBe(0);
    expect(status.scopes.find((scope) => scope.scope === "global")?.active).toBe(1);
  });

  test("refreshes exact duplicates instead of multiplying records", async () => {
    const box = await sandbox();
    const store = box.make(box.projectA);
    const first = await store.remember({ text: "Prefer focused tests.", scope: "project", tags: ["old"] });
    box.advanceDays(1);
    const refreshed = await store.remember({
      text: "Prefer focused tests.",
      scope: "project",
      tags: ["new"],
      expiresInDays: 30,
    });

    expect(refreshed.created).toBe(false);
    expect(refreshed.record.id).toBe(first.record.id);
    expect(refreshed.record.tags).toEqual(["new"]);
    expect(refreshed.record.updatedAt).not.toBe(first.record.updatedAt);
    expect((await store.status()).scopes.find((scope) => scope.scope === "project")?.active).toBe(1);
  });

  test("serializes concurrent writes to the same scope", async () => {
    const box = await sandbox();
    const store = box.make(box.projectA);
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.remember({
      text: `concurrent memory ${index}`,
      scope: "project",
    })));
    expect((await store.status()).scopes.find((scope) => scope.scope === "project")?.active).toBe(12);
  });
});

describe("retrieval, staleness, and deletion", () => {
  test("ranks phrase/tag matches, caps results, and returns bounded snippets", async () => {
    const box = await sandbox();
    const store = box.make(box.projectA);
    await store.remember({
      text: `${"prefix ".repeat(90)}exact deployment phrase${" suffix".repeat(90)}`,
      scope: "project",
      tags: ["release"],
    });
    await store.remember({ text: "Deployment notes without the phrase.", scope: "project" });
    await store.remember({ text: "Something else.", scope: "global", tags: ["deployment", "phrase"] });

    const results = await store.search({ query: "deployment phrase", maxResults: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]?.snippet).toContain("exact deployment phrase");
    expect(Array.from(results[0]!.snippet).length).toBeLessThanOrEqual(MAX_SEARCH_SNIPPET_CHARS + 2);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });

  test("excludes expired records from normal search but keeps them inspectable", async () => {
    const box = await sandbox();
    const store = box.make(box.projectA);
    const saved = await store.remember({
      text: "Temporary migration endpoint",
      scope: "project",
      expiresInDays: 1,
    });
    box.advanceDays(2);

    expect(await store.search({ query: "migration" })).toEqual([]);
    expect(await store.search({ query: "migration", includeExpired: true })).toMatchObject([{ expired: true }]);
    expect(await store.read(saved.record.id)).toMatchObject({ expired: true });
    expect((await store.status()).scopes.find((scope) => scope.scope === "project")).toMatchObject({ active: 0, expired: 1 });
  });

  test("forget rewrites the file without retaining deleted text", async () => {
    const box = await sandbox();
    const store = box.make(box.projectA);
    const saved = await store.remember({ text: "delete this durable sentence", scope: "project" });
    const forgotten = await store.forget(saved.record.id);

    expect(forgotten.forgotten?.text).toBe("delete this durable sentence");
    expect(await store.read(saved.record.id)).toBeUndefined();
    expect(await readFile(saved.path, "utf8")).not.toContain("delete this durable sentence");
    expect(await store.forget(saved.record.id)).toEqual({});
  });
});

describe("safety and corruption handling", () => {
  test("rejects likely credentials before creating a store", async () => {
    const box = await sandbox();
    const store = box.make(box.projectA);
    await expect(store.remember({
      text: "api_key=abcdefghijklmnopqrstuvwxyz123456",
      scope: "global",
    })).rejects.toThrow("looks like a credential assignment");
    expect(existsSync(store.pathFor("global"))).toBe(false);
  });

  test("fails closed on malformed or newer files without overwriting them", async () => {
    const box = await sandbox();
    const store = box.make(box.projectA);
    await mkdir(box.root, { recursive: true });
    const path = store.pathFor("global");
    const malformed = '{"version":99,"scope":{"kind":"global"},"entries":[]}\n';
    await writeFile(path, malformed);

    await expect(store.search({ query: "anything", scope: "global" })).rejects.toThrow("unsupported version 99");
    await expect(store.remember({ text: "do not overwrite", scope: "global" })).rejects.toThrow("unsupported version 99");
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  test("rejects symlinked stores instead of following them", async () => {
    if (process.platform === "win32") return;
    const box = await sandbox();
    const store = box.make(box.projectA);
    await mkdir(box.root, { recursive: true });
    const outside = join(box.base, "outside.json");
    await writeFile(outside, '{"version":1,"scope":{"kind":"global"},"entries":[]}\n');
    await symlink(outside, store.pathFor("global"));

    await expect(store.status()).rejects.toThrow("symlinked memory file");
    await expect(store.remember({ text: "must stay outside", scope: "global" })).rejects.toThrow("symlinked memory file");
    expect(await readFile(outside, "utf8")).not.toContain("must stay outside");
  });

  test("rejects a symlinked projects directory on both reads and writes", async () => {
    if (process.platform === "win32") return;
    const box = await sandbox();
    const store = box.make(box.projectA);
    const outside = join(box.base, "outside-projects");
    await mkdir(box.root, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(box.root, "projects"));

    await expect(store.search({ query: "project", scope: "project" })).rejects.toThrow("symlinked memory directory");
    await expect(store.remember({ text: "project write", scope: "project" })).rejects.toThrow("symlinked memory directory");
    expect(existsSync(join(outside, projectStoreFilename(box.projectA)))).toBe(false);
  });

  test("does not match every record for a punctuation-only query", async () => {
    const box = await sandbox();
    const store = box.make(box.projectA);
    await store.remember({ text: "ordinary record", scope: "project" });
    expect(await store.search({ query: "!!!" })).toEqual([]);
  });

  test("normalizes text and rejects empty, oversized, or control-character content", () => {
    expect(normalizeMemoryText(" line one\r\nline two ")).toBe("line one\nline two");
    expect(() => normalizeMemoryText("   ")).toThrow("cannot be empty");
    expect(() => normalizeMemoryText("x".repeat(4_001))).toThrow("4,000-character");
    expect(() => normalizeMemoryText("bad\u0000text")).toThrow("control characters");
  });
});
