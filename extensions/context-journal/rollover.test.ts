import { expect, test } from "bun:test";
import { contextBudget, installRollover, ROLLOVER_TEXT } from "./rollover.ts";
import { emptyJournal } from "./state.ts";
import { CHECKPOINT_ENTRY } from "./checkpoint.ts";

test("budget reserves a checkpoint phase below the context ceiling", () => {
  expect(contextBudget(undefined).phase).toBe("unknown");
  expect(contextBudget({ tokens: null, contextWindow: 100000 }).phase).toBe("unknown");
  expect(contextBudget({ tokens: 10000, contextWindow: 100000 }).phase).toBe("normal");
  expect(contextBudget({ tokens: 85000, contextWindow: 100000 }).phase).toBe("reminder");
  expect(contextBudget({ tokens: 90000, contextWindow: 100000 }).phase).toBe("checkpoint");
  expect(contextBudget({ tokens: 98000, contextWindow: 100000 }).phase).toBe("exhausted");
  expect(contextBudget({ tokens: 1, contextWindow: 8000 }).hard).toBe(7840);
  expect(contextBudget({ tokens: 1, contextWindow: 1000000 }).hard).toBe(916384);
});
function fixture() {
  const handlers = new Map<string, any>(); const tools = new Map<string, any>();
  const state = { ...emptyJournal(), enabled: true, notes: { objective: "finish all work" } };
  let tokens: number | null = 1000; let aborted = 0; let leaf = "old"; let compactions = 0;
  const entries: any[] = [{ id: "fresh", type: "custom", customType: CHECKPOINT_ENTRY, data: { version: 1 } }];
  const ctx: any = { getContextUsage: () => ({ tokens, contextWindow: 100000 }), isIdle: () => true, abort: () => aborted++, ui: { notify() {} }, sessionManager: { getLeafId: () => leaf, getBranch: () => entries },
    compact: (options: any) => { compactions++; const result = handlers.get("session_before_compact")({ reason: "manual", signal: new AbortController().signal, preparation: { tokensBefore: tokens } }, ctx); options.onComplete(result.compaction); handlers.get("session_compact")(); } };
  const policy = installRollover({ on: (name: string, handler: any) => handlers.set(name, handler), registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry: (customType: string, data: any) => { leaf = `entry-${entries.length}`; entries.push({ id: leaf, type: "custom", customType, data }); } } as never, () => state);
  const settle = async (outcome = "completed", proposals: any[] = []) => {
    const result = await handlers.get("agent_before_settle")({ outcome, entries: proposals }, ctx);
    if (result?.entries) for (const entry of result.entries) { entries.push({ ...entry, id: `entry-${entries.length}` }); if (entry.type === "compaction") compactions++; }
    return result;
  };
  return { handlers, tools, ctx, policy, state, entries, settle, tokens: (value: number | null) => { tokens = value; }, aborted: () => aborted, compactions: () => compactions };
}
test("warns once then permits only checkpoint writes and rollover", () => {
  const f = fixture(); f.tokens(85000);
  expect(f.handlers.get("context")({ messages: [] }, f.ctx).messages).toHaveLength(1);
  expect(f.handlers.get("context")({ messages: [] }, f.ctx).messages).toHaveLength(0);
  f.tokens(91000);
  expect(f.handlers.get("tool_call")({ toolName: "bash", input: {} }, f.ctx).block).toBe(true);
  expect(f.handlers.get("tool_call")({ toolName: "context_notes", input: { action: "write" } }, f.ctx)).toBeUndefined();
  expect(f.handlers.get("tool_call")({ toolName: "context_rollover", input: {} }, f.ctx)).toBeUndefined();
  f.tokens(98000);
  expect(f.handlers.get("tool_call")({ toolName: "bash", input: {} }, f.ctx).terminate).toBe(true);
  expect(f.aborted()).toBe(1);
});
test("rollover proposes a retain-none boundary before settlement and continues once", async () => {
  const f = fixture();
  await f.tools.get("context_rollover").execute("id", { checkpoint_ready: true }, undefined, undefined, f.ctx);
  expect(f.compactions()).toBe(0);
  expect(f.handlers.get("tool_call")({ toolName: "bash", input: {} }, f.ctx).terminate).toBe(true);
  f.ctx.isIdle = () => false;
  const proposal = await f.settle();
  expect(proposal.continue).toBe(true);
  expect(proposal.entries.at(-1)).toMatchObject({ type: "compaction", firstKeptEntryId: null });
  expect(f.compactions()).toBe(1);
  expect(f.entries).toHaveLength(2);
  expect(f.aborted()).toBe(0);
  expect(f.policy.status()).toBe("automatic");
  expect(await f.settle()).toBeUndefined();
});
test("native manual/overflow compaction stays unchanged without a pending rollover", () => {
  const f = fixture();
  for (const reason of ["manual", "overflow"]) expect(f.handlers.get("session_before_compact")({ reason, signal: new AbortController().signal }, f.ctx)).toBeUndefined();
  expect(f.handlers.get("session_before_compact")({ reason: "threshold", signal: new AbortController().signal }, f.ctx)).toEqual({ cancel: true });
  expect(f.compactions()).toBe(0);
});
test("idle input commits exhausted working context but does not consume the input", async () => {
  const f = fixture(); f.tokens(92000);
  expect(await f.handlers.get("input")({ text: "new request" }, f.ctx)).toBeUndefined();
  expect(f.compactions()).toBe(1);
  expect(ROLLOVER_TEXT).toContain("context_history");
});
test("disabled mode and empty checkpoints never discard context", async () => {
  const f = fixture(); f.state.notes = {} as any;
  await expect(f.policy.rollover(f.ctx)).rejects.toThrow("Save current objective");
  expect(f.compactions()).toBe(0);
  f.state.enabled = false;
  f.tokens(99000);
  expect(f.handlers.get("tool_call")({ toolName: "bash", input: {} }, f.ctx)).toBeUndefined();
  expect(f.handlers.get("session_before_compact")({ reason: "threshold" }, f.ctx)).toBeUndefined();
});

test("compaction errors release pending state and permit an explicit retry", async () => {
  const f = fixture();
  const original = f.ctx.compact;
  f.ctx.compact = (options: any) => options.onError(new Error("not ready"));
  await expect(f.policy.rollover(f.ctx)).rejects.toThrow("not ready");
  expect(f.policy.status()).toBe("automatic");
  f.ctx.compact = original;
  await f.policy.rollover(f.ctx);
  expect(f.compactions()).toBe(1);
});

test("disabling during preparation cancels instead of falling back to a summary call", async () => {
  const f = fixture(); let pending: any;
  f.ctx.compact = (options: any) => { pending = options; };
  const running = f.policy.rollover(f.ctx);
  f.state.enabled = false; f.policy.disable();
  expect(f.aborted()).toBe(1);
  expect(f.handlers.get("session_before_compact")({ reason: "manual", signal: new AbortController().signal }, f.ctx)).toEqual({ cancel: true });
  pending.onError(new Error("cancelled"));
  await expect(running).rejects.toThrow("cancelled");
});

test("late errors after a session switch do not notify or throw into the old session", async () => {
  const f = fixture(); let pending: any;
  f.ctx.compact = (options: any) => { pending = options; };
  const running = f.policy.rollover(f.ctx);
  f.handlers.get("session_shutdown")();
  pending.onError(new Error("old session"));
  await running;
  expect(f.policy.status()).toBe("automatic");
});

test("stale notes do not roll over on input or permit an explicit request", async () => {
  const f = fixture(); f.tokens(92000);
  f.entries.push({ type: "message", message: { role: "user", content: "A newer objective" } });
  await f.handlers.get("input")({}, f.ctx);
  expect(f.compactions()).toBe(0);
  await expect(f.tools.get("context_rollover").execute("id", { checkpoint_ready: true }, undefined, undefined, f.ctx)).rejects.toThrow("fresh");
  f.policy.checkpoint();
  await f.policy.rollover(f.ctx);
  expect(f.compactions()).toBe(1);
  // The prior cycle's checkpoint cannot authorize a second rollover.
  await f.handlers.get("input")({}, f.ctx);
  expect(f.compactions()).toBe(1);
  f.policy.checkpoint();
  await f.handlers.get("input")({}, f.ctx);
  expect(f.compactions()).toBe(2);
});

test("an accepted checkpoint permits a closing response but never new user work", async () => {
  for (const role of ["assistant", "user"] as const) {
    const f = fixture();
    await f.tools.get("context_rollover").execute("id", { checkpoint_ready: true }, undefined, undefined, f.ctx);
    f.entries.push({ type: "message", message: { role, content: "Continue after this boundary" } });
    await f.settle();
    expect(f.compactions()).toBe(role === "assistant" ? 1 : 0);
    expect(f.policy.status()).toBe("automatic");
  }
});

test("failed or aborted runs do not compact or request a continuation", async () => {
  for (const outcome of ["error", "aborted"]) {
    const f = fixture();
    await f.tools.get("context_rollover").execute("id", { checkpoint_ready: true }, undefined, undefined, f.ctx);
    expect(await f.settle(outcome)).toBeUndefined();
    expect(f.compactions()).toBe(0);
    expect(f.policy.status()).toBe("automatic");
  }
});

test("rollover preserves metadata proposals and defers when another handler adds model context", async () => {
  const metadata = { type: "custom", customType: "other-state", data: { safe: true } };
  const f = fixture();
  await f.tools.get("context_rollover").execute("id", { checkpoint_ready: true }, undefined, undefined, f.ctx);
  expect((await f.settle("completed", [metadata])).entries[0]).toEqual(metadata);
  for (const type of ["custom_message", "context_edit", "compaction"]) {
    const other = fixture();
    await other.tools.get("context_rollover").execute("id", { checkpoint_ready: true }, undefined, undefined, other.ctx);
    expect(await other.settle("completed", [{ type }])).toBeUndefined();
    expect(other.compactions()).toBe(0);
  }
});
