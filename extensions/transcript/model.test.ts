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
