import { expect, test } from "bun:test";
import { decorateCodexEditor } from "./editor.ts";

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
