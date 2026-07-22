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
