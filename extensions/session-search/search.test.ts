import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  MAX_QUERY_CHARS,
  compactText,
  parseSessionSearchArgs,
  resultDetails,
  resultLabel,
  sanitizeDisplayText,
  scanSession,
  scoreSearchText,
  searchSessions,
  selectCurrentProjectSessions,
} from "./search.ts";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-session-search-"));
  temporaryRoots.push(root);
  return root;
}

function session(path: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path,
    id: "session-12345678",
    cwd: "/tmp/project",
    name: "Router work",
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-02T00:00:00.000Z"),
    messageCount: 2,
    firstMessage: "Investigate the router",
    allMessagesText: "",
    ...overrides,
  };
}

describe("argument parsing and scoring", () => {
  test("parses quoted queries, aliases, literal options, and scope precedence", () => {
    expect(parseSessionSearchArgs('--current "cache invalidation" bug')).toEqual({
      query: "cache invalidation bug",
      scope: "current",
    });
    expect(parseSessionSearchArgs("--project alpha --all beta")).toEqual({ query: "alpha beta", scope: "all" });
    expect(parseSessionSearchArgs("--current -- --literal")).toEqual({ query: "--literal", scope: "current" });
    expect(parseSessionSearchArgs("quoted\\ value 'and more'")).toEqual({ query: "quoted value and more", scope: "all" });
    expect(() => parseSessionSearchArgs("--unknown query")).toThrow("Unknown session-search option");
    expect(() => parseSessionSearchArgs("'unterminated")).toThrow("Unterminated quote");
    expect(() => parseSessionSearchArgs("x".repeat(MAX_QUERY_CHARS + 1))).toThrow("at most");
  });

  test("rewards exact phrases, matches case-insensitively, and caps repetition", () => {
    const exact = scoreSearchText("Alpha beta appears twice: alpha beta", "alpha beta");
    const split = scoreSearchText("ALPHA then much later beta", "alpha beta");
    const repeated = scoreSearchText("alpha ".repeat(1_000), "alpha");
    expect(exact.score).toBeGreaterThan(split.score);
    expect(split.matchedTerms).toEqual(new Set(["alpha", "beta"]));
    expect(repeated.score).toBeLessThan(200);
  });
});

describe("bounded session scanning", () => {
  test("searches messages, tool results, errors, summaries, and malformed JSONL safely", async () => {
    const root = await temporaryRoot();
    const path = join(root, "session.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session", id: "session-12345678", cwd: root }),
      JSON.stringify({ id: "summary-1", type: "compaction", summary: "Router migration background", firstKeptEntryId: "user-1" }),
      JSON.stringify({ id: "user-1", type: "message", message: { role: "user", content: [{ type: "text", text: "Investigate the router" }] } }),
      JSON.stringify({ id: "assistant-1", type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        { type: "toolCall", name: "bash", arguments: { command: "run router check" } },
      ] } }),
      JSON.stringify({ id: "tool-1", type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Router failed with ECONNRESET" }] } }),
      JSON.stringify({ id: "error-1", type: "message", message: { role: "assistant", content: [], errorMessage: "Router provider timeout" } }),
      "not valid json",
    ].join("\n"));

    const found = await scanSession(session(path, { cwd: root }), "router ECONNRESET");
    expect(found.result).toMatchObject({ entryId: "tool-1", entryLabel: "bash result" });
    expect(found.result?.snippet).toContain("ECONNRESET");
    expect(found.malformedLines).toBe(1);
    expect(found.unreadable).toBe(false);

    expect((await scanSession(session(path, { cwd: root }), "migration background")).result?.entryId).toBe("summary-1");
    expect((await scanSession(session(path, { cwd: root }), "provider timeout")).result?.entryId).toBe("error-1");
    expect((await scanSession(session(path, { cwd: root }), "hidden chain")).result).toBeUndefined();
  });

  test("skips oversized lines, caps file reads, and can retain a metadata match", async () => {
    const root = await temporaryRoot();
    const path = join(root, "bounded.jsonl");
    const oversized = JSON.stringify({ id: "large", type: "message", message: { role: "assistant", content: "x".repeat(4_000) } });
    const match = JSON.stringify({ id: "small", type: "message", message: { role: "assistant", content: "small needle" } });
    await writeFile(path, `${oversized}\n${match}\n`);

    const skipped = await scanSession(session(path), "small needle", { maxLineChars: 300 });
    expect(skipped.result?.entryId).toBe("small");
    expect(skipped.oversizedLines).toBe(1);

    const capped = await scanSession(session(path, { name: "metadata needle" }), "metadata needle", { maxFileBytes: 10 });
    expect(capped.result?.entryLabel).toBe("session title");
    expect(capped.truncated).toBe(true);
  });

  test("reports unreadable files while preserving searchable session metadata", async () => {
    const root = await temporaryRoot();
    const outcome = await scanSession(session(join(root, "missing.jsonl"), { name: "Lost deployment notes" }), "deployment notes");
    expect(outcome.unreadable).toBe(true);
    expect(outcome.result?.entryLabel).toBe("session title");
  });

  test("ranks and caps concurrent multi-session results with progress accounting", async () => {
    const root = await temporaryRoot();
    const sessions: SessionInfo[] = [];
    for (let index = 0; index < 4; index++) {
      const path = join(root, `${index}.jsonl`);
      await writeFile(path, JSON.stringify({
        id: `entry-${index}`,
        type: "message",
        message: { role: "assistant", content: `alpha beta ${"alpha beta ".repeat(index)}` },
      }));
      sessions.push(session(path, {
        id: `session-${index}`,
        name: index === 3 ? "alpha beta exact title" : `Work ${index}`,
        modified: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
      }));
    }
    const progress: number[] = [];
    const summary = await searchSessions(sessions, "alpha beta", {
      concurrency: 2,
      maxResults: 2,
      onProgress: (completed) => progress.push(completed),
    });
    expect(summary.scannedSessions).toBe(4);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0]?.session.id).toBe("session-3");
    expect(progress.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });
});

describe("project scoping and display", () => {
  test("groups subdirectories by nearest git root and excludes nested or sibling repositories", async () => {
    const root = await temporaryRoot();
    const repo = join(root, "repo");
    const subdirectory = join(repo, "packages", "app");
    const nested = join(repo, "vendor", "nested");
    const sibling = join(root, "sibling");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(subdirectory, { recursive: true });
    await mkdir(join(nested, ".git"), { recursive: true });
    await mkdir(join(sibling, ".git"), { recursive: true });

    const candidates = [
      session("/tmp/1", { id: "root", cwd: repo }),
      session("/tmp/2", { id: "sub", cwd: subdirectory }),
      session("/tmp/3", { id: "nested", cwd: nested }),
      session("/tmp/4", { id: "sibling", cwd: sibling }),
      session("/tmp/5", { id: "deleted", cwd: join(repo, "deleted-directory") }),
      session("/tmp/6", { id: "legacy", cwd: "" }),
    ];
    const selected = selectCurrentProjectSessions(candidates, subdirectory);
    expect(selected.kind).toBe("git");
    expect(selected.projectRoot).toBe(realpathSync.native(repo));
    expect(selected.sessions.map((item) => item.id)).toEqual(["root", "sub", "deleted"]);
  });

  test("outside git, current scope requires the exact working directory", async () => {
    const root = await temporaryRoot();
    const child = join(root, "child");
    await mkdir(child);
    const selected = selectCurrentProjectSessions([
      session("/tmp/1", { id: "same", cwd: root }),
      session("/tmp/2", { id: "child", cwd: child }),
    ], root);
    expect(selected.kind).toBe("cwd");
    expect(selected.sessions.map((item) => item.id)).toEqual(["same"]);
  });

  test("sanitizes and bounds labels, details, and snippets", () => {
    const value = session("/tmp/session", {
      id: "abcdefgh12345678",
      cwd: "/Users/test/project",
      name: `\u001b[31m${"long ".repeat(30)}`,
    });
    const result = {
      session: value,
      score: 1,
      snippet: "safe excerpt",
      entryLabel: "assistant message",
      truncated: true,
      malformedLines: 1,
      oversizedLines: 1,
    };
    expect(resultLabel(result, 0, "/Users/test")).toStartWith("1. 2026-01-02");
    expect(resultLabel(result, 0, "/Users/test")).not.toContain("\u001b");
    expect(resultDetails(result, "/Users/test")).toContain("file scan capped");
    expect(resultDetails(result, "/Users/test")).toContain("~/project");
    expect(compactText("x".repeat(100), 10)).toHaveLength(10);
    expect(sanitizeDisplayText("a\u0000b\u001b[31mc")).toBe("abc");
  });
});
