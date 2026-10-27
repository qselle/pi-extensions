import { expect, test } from "bun:test";
import { transcriptBlocks } from "../../lib/transcript/model.ts";

test("represents messages, thinking, tools, errors, images and context summaries", () => {
  const blocks = transcriptBlocks([
    { id: "u", type: "message", message: { role: "user", content: [{ type: "text", text: "question" }, { type: "image", mimeType: "image/png", data: "secret-base64" }] } },
    { id: "a", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "**answer**" }, { type: "toolCall", name: "read", arguments: { path: "file.ts" } }] } },
    { id: "t", type: "message", message: { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "not found" }] } },
    { id: "c", type: "compaction", summary: "summary text" },
    { id: "s", type: "message", message: { role: "bashExecution", command: "false", output: "failure", exitCode: 1 } },
  ]);
  expect(blocks.map((b) => b.kind)).toEqual(["user", "thinking", "assistant", "tool", "tool", "summary", "tool"]);
  expect(blocks[0]!.body).toContain("[Image · image/png]");
  expect(blocks[4]!.failed).toBe(true);
  expect(blocks[6]!.failed).toBe(true);
  expect(JSON.stringify(blocks)).not.toContain("secret-base64");
  expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
});

test("hidden context and arbitrary extension state are not displayed", () => {
  const blocks = transcriptBlocks([
    { type: "custom", customType: "secret", data: "private" },
    { type: "custom_message", display: false, content: "hidden prompt" },
    { type: "custom_message", display: true, customType: "Visible", content: "visible message" },
    null,
  ]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.body).toBe("visible message");
});

test("removes terminal controls without truncating large transcript content", () => {
  const content = "\x1b]0;bad\x07\x1b[31m" + "row\n".repeat(100000) + "\x1b[0m";
  const blocks = transcriptBlocks([{ id: "u", type: "message", message: { role: "user", content } }]);
  expect(blocks[0]!.body).toBe("row\n".repeat(100000));
});

test("tool calls show the purpose and one bounded line per argument", () => {
  const call = (name: string, args: unknown) => ({ type: "toolCall", name, arguments: args });
  const blocks = transcriptBlocks([{ id: "a", type: "message", message: { role: "assistant", content: [
    call("bash", { purpose: "Run the focused tests", command: "bun test", timeout: 30 }),
    call("read", { reasoning: "check config", path: "a.ts", options: { limit: 5 } }),
    call("edit", { purpose: "Fix retry", path: "a.ts", edits: [{ oldText: "secret-old", newText: "new" }, { oldText: "x", newText: "y" }] }),
    call("write", { path: "b.ts", content: "one\ntwo\nthree" }),
    call("bash", { command: "x".repeat(700) }),
    call("noop", {}),
  ] } }]);
  expect(blocks.map((block) => block.body)).toEqual([
    "Run the focused tests\ncommand  bun test\ntimeout  30",
    "check config\npath  a.ts\noptions  {\"limit\":5}",
    "Fix retry\npath  a.ts\nedits  2 replacements",
    "path  b.ts\ncontent  3 lines · 13 chars",
    `command  ${"x".repeat(600)}… (700 chars)`,
    "(no arguments)",
  ]);
  expect(JSON.stringify(blocks)).not.toContain("secret-old");
});

test("shows model and thinking-level changes and hides web-search source markers", () => {
  const blocks = transcriptBlocks([
    { id: "m", type: "model_change", provider: "mistral", modelId: "mistral-medium-3.5" },
    { id: "t", type: "thinking_level_change", thinkingLevel: "high" },
    { id: "u", type: "message", message: { role: "user", content: "hello<!-- pi:web-search-source:x --> world" } },
    { id: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "see [1]<!-- pi:web-search-query-count:2 -->" }] } },
  ]);
  expect(blocks.map((block) => [block.label, block.body])).toEqual([
    ["Model", "mistral/mistral-medium-3.5"],
    ["Thinking level", "high"],
    ["You", "hello world"],
    ["Assistant", "see [1]"],
  ]);
});
