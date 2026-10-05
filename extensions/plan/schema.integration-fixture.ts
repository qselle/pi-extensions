import assert from "node:assert/strict";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import planExtension from "./index.ts";

function register() {
  const tools = new Map<string, any>();
  const entries: any[] = [];
  planExtension({
    on() {}, registerCommand() {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    sendMessage() {},
    events: { on: () => () => {}, emit() {} },
  } as any);
  return { tool: tools.get("update_plan"), entries };
}

const { tool } = register();
const call = (args: unknown): ToolCall => ({ type: "toolCall", id: "call", name: "update_plan", arguments: args as ToolCall["arguments"] });
/** Run the same preparation and validation Pi applies before execute(). */
const accept = (args: unknown) => validateToolArguments(tool, call(tool.prepareArguments(args)));

assert.equal(tool.executionMode, "sequential");
assert.equal(tool.parameters.additionalProperties, false);
assert.equal(tool.parameters.properties.plan.items.additionalProperties, false);

const flat = {
  reason: "Split verification into focused checks",
  plan: [
    { step: "Build", depth: 0 },
    { step: "Implement", status: "completed", depth: 1 },
    { step: "Verify", depth: 1, description: "Run focused checks." },
    { step: "Unit tests", status: "in_progress", depth: 2 },
    { step: "Integration", status: "pending", depth: 2 },
    { step: "Document", status: "pending" },
  ],
};
const nested = {
  explanation: "Split verification into focused checks",
  plan: [
    { step: "Build", children: [
      { step: "Implement", status: "completed" },
      { step: "Verify", description: "Run focused checks.", children: [
        { step: "Unit tests", status: "in_progress" },
        { step: "Integration", status: "pending" },
      ] },
    ] },
    { step: "Document", status: "pending" },
  ],
};
assert.deepEqual(tool.prepareArguments(flat), nested);
assert.deepEqual(accept(flat), nested);
assert.equal(tool.prepareArguments(nested), nested, "nested payloads pass through unchanged");

// Raw flat rows are not valid schema input on their own.
assert.throws(() => validateToolArguments(tool, call(flat)));
assert.throws(() => accept({ plan: [{ step: "Build", status: "in_progress", owner: "me" }] }), /owner|additional/i);
assert.throws(() => accept({ plan: [], extra: true }), /extra|additional/i);

const fromFlat = register();
await fromFlat.tool.execute("flat", accept(flat));
const fromNested = register();
await fromNested.tool.execute("nested", accept(nested));
assert.deepEqual(
  { ...fromFlat.entries.at(-1).data.plan, updatedAt: 0 },
  { ...fromNested.entries.at(-1).data.plan, updatedAt: 0 },
  "flat rows build the same plan tree",
);
assert.equal(fromFlat.entries.at(-1).data.plan.items[0].status, "in_progress", "parent status is derived");
assert.equal(fromFlat.entries.at(-1).data.plan.explanation, "Split verification into focused checks");

// An explanation wins over a duplicate reason.
assert.deepEqual(tool.prepareArguments({ reason: "r", explanation: "e", plan: [] }), { explanation: "e", plan: [] });
assert.throws(() => tool.prepareArguments({ plan: [{ step: "A", depth: 1, status: "pending" }] }), /skips a level.*children/);
assert.throws(() => tool.prepareArguments({ plan: [{ step: "A", depth: -1, status: "pending" }] }), /invalid depth/);
assert.throws(() => tool.prepareArguments({ plan: [{ step: "A" }, { step: "B", depth: 1 }, { step: "C", depth: 2 }, { step: "D", depth: 3, status: "pending" }] }), /at most 3 levels/);
await assert.rejects(register().tool.execute("x", accept({ plan: [{ step: "Group", depth: 0 }, { step: "Leaf", depth: 0 }] })), /needs a status.*children/);

console.log("update_plan accepts flat depth rows and rejects unknown fields");
