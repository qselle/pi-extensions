/**
 * codex-prompt — adds a flat Codex-style `›` input prompt to pi's editor
 * (keeping the editor's `─` rules).
 *
 * Safety model: decorates only the current editor's `render` method — all input
 * handling, keybindings, history, autocomplete, and paste behavior stay on the
 * wrapped editor, so typing can never break. The transform falls back to the
 * original rendering on any error, so the worst case is cosmetic. Reversible
 * via `~/.pi/agent/codex-prompt.json`
 * `{ "enabled": false }` or `/codex-prompt off` + `/reload`.
 */

import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decorateCodexEditor } from "./editor.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

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
	let previousFactory: EditorFactory | undefined;
	let installedFactory: EditorFactory | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!readEnabled()) return;

		previousFactory = ctx.ui.getEditorComponent();
		installedFactory = (tui, theme, keybindings) => {
			const editor = previousFactory?.(tui, theme, keybindings)
				?? new CustomEditor(tui, theme, keybindings);
			return decorateCodexEditor(editor);
		};
		ctx.ui.setEditorComponent(installedFactory);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (ctx.ui.getEditorComponent() === installedFactory) {
			ctx.ui.setEditorComponent(previousFactory);
		}
		previousFactory = undefined;
		installedFactory = undefined;
	});

	pi.registerCommand("codex-prompt", {
		description: "Toggle the Codex-style › input prompt (reload to apply)",
		handler: async (args, ctx) => {
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
