import { expect, test } from "bun:test";
import {
  MAX_MEMORY_TOOL_OUTPUT_CHARS,
  boundOutput,
  formatMemorySearch,
  formatMemoryStatus,
} from "./format.ts";

test("bounds complete tool output and marks truncation", () => {
  const output = boundOutput("x".repeat(MAX_MEMORY_TOOL_OUTPUT_CHARS * 2));
  expect(Array.from(output).length).toBeLessThanOrEqual(MAX_MEMORY_TOOL_OUTPUT_CHARS);
  expect(output).toEndWith("… [output truncated]");
});

test("search formatting removes controls and remains bounded across maximum-shaped results", () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    id: `m_result-${index}`,
    scope: "project" as const,
    projectRoot: "/repo",
    snippet: `${"snippet ".repeat(80)}\u001b[31m`,
    tags: Array.from({ length: 12 }, (__, tag) => `tag-${index}-${tag}-${"x".repeat(25)}`),
    updatedAt: "2026-01-02T03:04:05.000Z",
    expired: false,
    score: 10,
  }));
  const output = formatMemorySearch("query", results);
  expect(Array.from(output).length).toBeLessThanOrEqual(MAX_MEMORY_TOOL_OUTPUT_CHARS);
  expect(output).not.toContain("\u001b");
});

test("status discloses paths and counts but not record contents", () => {
  const output = formatMemoryStatus({
    root: "/agent/memory",
    scopes: [
      { scope: "project", projectRoot: "/repo", path: "/agent/memory/projects/repo.json", active: 2, expired: 1 },
      { scope: "global", path: "/agent/memory/global.json", active: 3, expired: 0 },
    ],
  });
  expect(output).toContain("project: 2 active, 1 expired");
  expect(output).toContain("global: 3 active, 0 expired");
  expect(output).toContain("no session history is preloaded");
});
