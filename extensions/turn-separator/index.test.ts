import { describe, expect, test } from "bun:test";
import turnSeparator from "./index.ts";

/** Fake ExtensionAPI that captures handlers, appended entries, and the renderer. */
function harness() {
	const handlers: Record<string, (event: any, ctx: any) => void> = {};
	const appended: Array<{ type: string; data: any }> = [];
	let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
	const pi: any = {
		on: (evt: string, h: (event: any, ctx: any) => void) => {
			handlers[evt] = h;
		},
		appendEntry: (type: string, data: any) => {
			appended.push({ type, data });
		},
		registerEntryRenderer: (_type: string, r: any) => {
			renderer = r;
		},
	};
	turnSeparator(pi);
	const ctx = { mode: "tui" };
	const fire = (evt: string, event: any = {}) => handlers[evt]?.(event, ctx);
	return {
		fire,
		appended,
		get renderer() {
			return renderer;
		},
	};
}

const assistant = { message: { role: "assistant" } };

describe("turn-separator wiring", () => {
	test("appends a separator before an assistant message that followed tool work", () => {
		const h = harness();
		h.fire("turn_start", { turnIndex: 0 });
		h.fire("message_start", assistant); // first response, no prior work
		expect(h.appended.length).toBe(0);

		h.fire("tool_execution_start", { toolName: "bash" });
		h.fire("message_start", assistant); // response after tools → separator
		expect(h.appended.length).toBe(1);
		expect(h.appended[0]!.type).toBe("worked-for-separator");
		expect(typeof h.appended[0]!.data.seconds).toBe("number");
	});

	test("ignores non-assistant messages; resets after each separator", () => {
		const h = harness();
		h.fire("tool_execution_start", {});
		h.fire("message_start", { message: { role: "user" } });
		expect(h.appended.length).toBe(0); // user message is not a separator point

		h.fire("message_start", assistant);
		expect(h.appended.length).toBe(1);

		h.fire("message_start", assistant); // no new work since → no separator
		expect(h.appended.length).toBe(1);
	});

	test("a mid-turn turn_start does not swallow the separator (regression)", () => {
		const h = harness();
		h.fire("tool_execution_start", {});
		h.fire("turn_start", {}); // re-fires per model round-trip; must not reset pending work
		h.fire("message_start", assistant);
		expect(h.appended.length).toBe(1);
	});

	test("renderer draws a labeled dim rule", () => {
		const h = harness();
		const theme = { fg: (_c: string, s: string) => s };
		const lines = h.renderer!({ data: { seconds: 74 } }, { expanded: false }, theme).render(40);
		expect(lines[0]).toContain("Worked for 1m 14s");
	});
});

const usage = (over: any = {}) => ({
	message: {
		role: "assistant",
		usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 }, ...over },
	},
});

describe("turn-separator stats", () => {
	test("accumulates usage from every response in the work block", () => {
		const h = harness();
		h.fire("message_start", assistant);
		h.fire("message_end", usage());
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant); // emits, carrying the block's usage

		const stats = h.appended[0]!.data.stats;
		expect(stats).toMatchObject({ input: 100, output: 50, cacheRead: 900, cost: 0.01 });
	});

	test("sums several responses before the separator", () => {
		const h = harness();
		h.fire("message_start", assistant);
		h.fire("message_end", usage());
		h.fire("message_end", usage({ output: 25, cost: { total: 0.02 } }));
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant);
		expect(h.appended[0]!.data.stats).toMatchObject({ output: 75, cost: 0.03 });
	});

	test("records ttft from the request-send anchor, not message_start", () => {
		const h = harness();
		h.fire("message_start", assistant);
		h.fire("before_provider_request", { payload: {} });
		h.fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
		h.fire("message_end", usage());
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant);
		expect(typeof h.appended[0]!.data.stats.ttftMs).toBe("number");
	});

	test("omits ttft when there was no send anchor, instead of reporting 0ms", () => {
		const h = harness();
		h.fire("message_start", assistant);
		h.fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
		h.fire("message_end", usage());
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant);
		// A 0ms ttft is a measurement artifact, never a real provider latency.
		expect(h.appended[0]!.data.stats.ttftMs).toBeUndefined();
	});

	test("ignores non-delta stream events for ttft", () => {
		const h = harness();
		h.fire("message_start", assistant);
		h.fire("before_provider_request", { payload: {} });
		h.fire("message_update", { assistantMessageEvent: { type: "toolcall_delta" } });
		h.fire("message_end", { message: { role: "assistant", usage: { output: 0 } } });
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant);
		expect(h.appended[0]!.data.stats?.ttftMs).toBeUndefined();
	});

	test("omits stats entirely when nothing was recorded", () => {
		const h = harness();
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant);
		expect(h.appended[0]!.data.stats).toBeUndefined();
	});

	test("starts a fresh block after each separator", () => {
		const h = harness();
		h.fire("message_start", assistant);
		h.fire("message_end", usage());
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant);
		h.fire("message_end", usage({ output: 7, cost: { total: 0.05 } }));
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant);
		expect(h.appended).toHaveLength(2);
		expect(h.appended[1]!.data.stats).toMatchObject({ output: 7, cost: 0.05 });
	});

	test("ignores usage from non-assistant messages", () => {
		const h = harness();
		h.fire("message_end", { message: { role: "toolResult", usage: { output: 999 } } });
		h.fire("tool_execution_start", {});
		h.fire("message_start", assistant);
		expect(h.appended[0]!.data.stats).toBeUndefined();
	});

	test("session_start clears a pending block", () => {
		const h = harness();
		h.fire("message_end", usage());
		h.fire("tool_execution_start", {});
		h.fire("session_start", {});
		h.fire("message_start", assistant);
		expect(h.appended).toHaveLength(0);
	});

	test("renderer includes stats in the rule", () => {
		const h = harness();
		const theme = { fg: (_c: string, s: string) => s };
		const entry = { data: { seconds: 74, stats: { input: 100, output: 318, cacheRead: 4_100, cacheWrite: 0, cost: 0.21 } } };
		const line = h.renderer!(entry, { expanded: false }, theme).render(100)[0];
		expect(line).toContain("Worked for 1m 14s");
		expect(line).toContain("↑318");
		expect(line).toContain("$0.21");
	});

	test("renderer still handles legacy entries with only seconds", () => {
		const h = harness();
		const theme = { fg: (_c: string, s: string) => s };
		const line = h.renderer!({ data: { seconds: 5 } }, { expanded: false }, theme).render(60)[0];
		expect(line).toContain("Worked for 5s");
		expect(line).not.toContain("$");
	});
});
