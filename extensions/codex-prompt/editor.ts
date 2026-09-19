import { truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";
import { transformEditorLines } from "./transform.ts";

/** Add the Codex prompt renderer while retaining the supplied editor object. */
export function decorateCodexEditor<T extends EditorComponent>(editor: T, accent?: (text: string) => string): T {
	const render = editor.render.bind(editor);
	try {
		editor.setPaddingX?.(2);
	} catch {
		// Keep the wrapped editor's padding when it cannot be configured.
	}
	editor.render = (width: number) => {
		if (width <= 0) return [];
		// Pi's word wrapper can recurse forever when a wide glyph exceeds the
		// available content width. Render a minimal safe canvas, then clip it.
		const renderWidth = Math.max(8, width);
		const originalBorder = editor.borderColor;
		let base: string[];
		try {
			if (accent) editor.borderColor = accent;
			base = render(renderWidth);
		} catch {
			editor.borderColor = originalBorder;
			base = render(renderWidth);
		} finally { editor.borderColor = originalBorder; }
		try {
			const prompt = `${(accent ?? editor.borderColor)?.("›") ?? "›"} `;
			return transformEditorLines(base, prompt).map((line) =>
				visibleWidth(line) <= width ? line : truncateToWidth(line, width, ""),
			);
		} catch {
			return base.map((line) => visibleWidth(line) <= width ? line : truncateToWidth(line, width, ""));
		}
	};
	return editor;
}
