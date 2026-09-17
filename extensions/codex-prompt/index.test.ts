import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codexPromptExtension from "./index.ts";
import { decorateCodexEditor } from "./editor.ts";

class MockPi {
	readonly handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();

	registerCommand(): void {}

	on(name: string, handler: (event: unknown, ctx: any) => unknown): void {
		const handlers = this.handlers.get(name) ?? [];
		handlers.push(handler);
		this.handlers.set(name, handlers);
	}

	async emit(name: string, event: unknown, ctx: any): Promise<void> {
		for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
	}
}

const editorTheme = {
	borderColor: (value: string) => value,
	selectList: {
		selectedPrefix: (value: string) => value,
		selectedText: (value: string) => value,
		description: (value: string) => value,
		scrollInfo: (value: string) => value,
		noMatch: (value: string) => value,
	},
};
const keybindings = { matches: () => false };

test("decorates an existing editor without replacing its input behavior", () => {
	const inputs: string[] = [];
	let padding: number | undefined;
	const editor = {
		render: (_width: number) => ["──────────", "  hello", "──────────"],
		handleInput: (data: string) => inputs.push(data),
		invalidate() {},
		getText: () => "hello",
		setText() {},
		borderColor: (value: string) => `[${value}]`,
		setPaddingX: (value: number) => { padding = value; },
	};

	const decorated = decorateCodexEditor(editor);
	decorated.handleInput("x");

	expect(decorated).toBe(editor);
	expect(inputs).toEqual(["x"]);
	expect(padding).toBe(2);
	expect(decorated.render(10)).toEqual(["──────────", "[›] hello", "──────────"]);
});

test("fallback editor embeds Pi's working indicator in regular and fullscreen modes", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-prompt-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		for (const tuiMode of ["regular", "fullscreen"] as const) {
			const pi = new MockPi();
			let currentFactory: any;
			const ctx = {
				mode: "tui",
				ui: {
					getEditorComponent: () => currentFactory,
					setEditorComponent: (factory: any) => { currentFactory = factory; },
				},
			};

			codexPromptExtension(pi as any);
			await pi.emit("session_start", {}, ctx);
			const editor = currentFactory(
				{ mode: tuiMode, terminal: { rows: 24 }, requestRender() {} },
				editorTheme,
				keybindings,
			);

			expect(editor.embedWorkingStatus).toBe(true);
			editor.setWorkingStatusIndicator({
				renderInBorder: () => "⠋ Working",
				renderSpinnerInBorder: () => "⠋",
			});
			expect(editor.render(48).some((line: string) => line.includes("Working"))).toBe(true);

			await pi.emit("session_shutdown", {}, ctx);
			expect(currentFactory).toBeUndefined();
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
