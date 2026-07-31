import { truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";
import { transformEditorLines } from "./transform.ts";

/** Add the Codex prompt renderer while retaining the supplied editor object. */
export function decorateCodexEditor<T extends EditorComponent>(editor: T): T {
	const render = editor.render.bind(editor);
	try {
		editor.setPaddingX?.(2);
	} catch {
		// Keep the wrapped editor's padding when it cannot be configured.
	}
	editor.render = (width: number) => {
		const base = render(width);
		try {
			const prompt = `${editor.borderColor?.("›") ?? "›"} `;
			return transformEditorLines(base, prompt).map((line) =>
				visibleWidth(line) <= width ? line : truncateToWidth(line, width, ""),
			);
		} catch {
			return base;
		}
	};
	return editor;
}
