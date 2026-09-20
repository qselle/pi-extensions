import { expect, test } from "bun:test";
import { CHECKPOINT_ENTRY, currentCheckpoint } from "./checkpoint.ts";
const marker = { type: "custom", id: "checkpoint", customType: CHECKPOINT_ENTRY, data: { version: 1 } };
const message = (role: string, content: any, toolName?: string) => ({ type: "message", message: { role, content, toolName } });
test("only checkpoint tools can follow a fresh checkpoint before requesting rollover", () => {
  expect(currentCheckpoint([marker, message("toolResult", [], "context_notes"), message("assistant", [{ type: "toolCall", name: "context_rollover" }])])).toBe("checkpoint");
  for (const entry of [message("user", "new work"), message("assistant", [{ type: "text", text: "new finding" }]), message("toolResult", [], "bash"), message("assistant", [{ type: "toolCall", name: "read" }]), { type: "compaction" }]) {
    expect(currentCheckpoint([marker, entry])).toBeUndefined();
  }
  expect(currentCheckpoint([marker, message("toolResult", [], "bash")], "checkpoint")).toBeUndefined();
});
