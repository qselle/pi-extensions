/**
 * codex-prompt — adds a flat Codex-style `›` input prompt to pi's editor
 * (keeping the editor's `─` rules).
 *
 * Safety model: subclasses `CustomEditor` and overrides **only** `render` — all
 * input handling, keybindings, history, autocomplete, and paste behavior are
 * inherited unchanged, so typing can never break. `render` wraps the transform
 * in try/catch and falls back to the default rendering on any error, so the
 * worst case is cosmetic. Reversible via `~/.pi/agent/codex-prompt.json`
 * `{ "enabled": false }` or `/codex-prompt off` + `/reload`.
 */

import { CustomEditor, getAgentDir, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformEditorLines } from "./transform.ts";

class CodexEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		// Reserve a 2-column gutter that render() rewrites into the "› " prompt.
		try {
			this.setPaddingX(2);
		} catch {
			// keep default padding if unavailable
		}
	}

	render(width: number): string[] {
		const base = super.render(width);
		try {
			const prompt = `${this.borderColor("›")} `;
			return transformEditorLines(base, prompt).map((l) =>
				visibleWidth(l) <= width ? l : truncateToWidth(l, width, ""),
			);
		} catch {
			return base;
		}
	}
}

const configPath = () => join(getAgentDir(), "codex-prompt.json");

function readEnabled(): boolean {
	try {
		return JSON.parse(readFileSync(configPath(), "utf8"))?.enabled !== false;
	} catch {
		return true;
	}
}

function writeEnabled(on: boolean): void {
	try {
		writeFileSync(configPath(), `${JSON.stringify({ enabled: on }, null, 2)}\n`);
	} catch {
		// best-effort; toggling is a convenience
	}
}

export default function codexPromptExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!readEnabled()) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new CodexEditor(tui, theme, keybindings));
	});

	pi.registerCommand("codex-prompt", {
		description: "Toggle the Codex-style › input prompt (reload to apply)",
		handler: async (args: string, ctx: any) => {
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				writeEnabled(arg === "on");
				ctx.ui.notify(`codex-prompt ${arg} — run /reload to apply.`, "info");
			} else {
				ctx.ui.notify(
					`codex-prompt is currently ${readEnabled() ? "on" : "off"}. Use \`/codex-prompt on|off\` (reload to apply).`,
					"info",
				);
			}
		},
	});
}
