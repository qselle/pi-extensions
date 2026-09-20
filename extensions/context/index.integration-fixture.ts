/** Uses Pi's real session conversion API in a clean process. */
import assert from "node:assert/strict";
import {
  convertToLlm,
  estimateTokens,
  sessionEntryToContextMessages,
  type CustomMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { analyzeContext } from "./analysis.ts";
import { renderReport } from "./render.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { piEstimators } from "./index.ts";

const entry: CustomMessageEntry = {
  id: "custom-1",
  parentId: null,
  timestamp: new Date(0).toISOString(),
  type: "custom_message",
  customType: "goal-context",
  content: [{ type: "text", text: "A concrete goal payload." }],
  display: false,
};

const [runtimeMessage] = sessionEntryToContextMessages(entry);
assert(runtimeMessage, "Pi should convert a custom entry into a runtime message");
assert.equal(piEstimators.entry(entry), estimateTokens(runtimeMessage));

const report = analyzeContext({ entries: [entry] }, piEstimators);
assert.equal(report.conversation.total, estimateTokens(runtimeMessage));
assert.deepEqual(report.conversation.buckets.map((bucket) => bucket.id), ["custom:goal-context"]);

const excludedShellEntry = {
  id: "bash-1",
  parentId: entry.id,
  timestamp: new Date(1).toISOString(),
  type: "message",
  message: {
    role: "bashExecution",
    command: "secret command",
    output: "secret output",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    excludeFromContext: true,
    timestamp: 1,
  },
};
const shellMessages = sessionEntryToContextMessages(excludedShellEntry as never);
assert.equal(convertToLlm(shellMessages).length, 0, "Pi should omit excluded shell executions");
assert.equal(analyzeContext({ entries: [excludedShellEntry] }, piEstimators).conversation.total, 0);

const assistantEntry = {
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
    ],
  },
};
const assistantReport = analyzeContext({ entries: [assistantEntry] }, piEstimators);
assert.equal(assistantReport.conversation.total, piEstimators.entry(assistantEntry));
assert.deepEqual(
  new Set(assistantReport.conversation.buckets.map((bucket) => bucket.id)),
  new Set(["assistant-reasoning", "assistant-answers", "assistant-tool-calls"]),
);

const unicodeReport = analyzeContext({ entries: [], systemPrompt: "text" }, piEstimators);
unicodeReport.system = { total: 123, buckets: [{ id: "unicode", label: "界🌍é".repeat(20), tokens: 123 }] };
const theme = { fg: (_: string, text: string) => `\x1b[2m${text}\x1b[0m`, bold: (text: string) => text };
for (const width of [0, 1, 12, 28, 40, 80]) for (const expanded of [false, true]) {
  const lines = renderReport(unicodeReport, theme, width, expanded);
  assert(lines.every((line) => visibleWidth(line) <= width));
  assert(lines.every((line) => !line.includes("�")));
}
console.log("context integration verified");

const persistedPrompt = { type: "message", message: { role: "system", content: "Current instructions", timestamp: 0 } };
const promptReport = analyzeContext({ entries: [persistedPrompt], systemPrompt: "Current instructions" }, piEstimators);
assert.equal(promptReport.conversation.total, 0, "persisted system prompts must not be counted twice");
assert(promptReport.system.total > 0);
