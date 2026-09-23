import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { accentColor, parseAccent, readSettings, writeSettings } from "./config.ts";
import { decorateCodexEditor } from "./editor.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const configPath = () => join(getAgentDir(), "codex-prompt.json");


export default function codexPromptExtension(pi: ExtensionAPI): void {
	let previousFactory: EditorFactory | undefined;
	let installedFactory: EditorFactory | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const settings = readSettings(configPath());
		if (!settings.enabled) return;
		if (ctx.ui.getEditorComponent() === installedFactory && installedFactory) return;

		previousFactory = ctx.ui.getEditorComponent();
		const wrappedFactory = previousFactory;
		installedFactory = (tui, theme, keybindings) => {
			const editor = wrappedFactory?.(tui, theme, keybindings)
				?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			const accent = accentColor(settings.accent, (text) => ctx.ui.theme?.fg("accent", text) ?? theme.borderColor(text));
			const border = settings.accent === "theme"
				? (text: string) => ctx.ui.theme?.fg("borderAccent", text) ?? theme.borderColor(text)
				: accent;
			return decorateCodexEditor(editor, accent, border);
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
		description: "Configure prompt and accent: /codex-prompt on|off|accent <theme|thinking|#hex> (reload to apply)",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			try {
				if (arg === "on" || arg === "off") {
					writeSettings(configPath(), { enabled: arg === "on" });
					ctx.ui.notify(`codex-prompt ${arg} — run /reload to apply.`, "info");
				} else if (arg.startsWith("accent ")) {
					const accent = parseAccent(arg.slice(7));
					if (!accent) { ctx.ui.notify("Accent must be theme, thinking, #RGB or #RRGGBB.", "error"); return; }
					writeSettings(configPath(), { accent });
					ctx.ui.notify(`Editor accent ${accent} — run /reload to apply.`, "info");
				} else {
					const settings = readSettings(configPath());
					ctx.ui.notify(`Prompt ${settings.enabled ? "on" : "off"} · accent ${settings.accent}. Use /codex-prompt on|off|accent <theme|thinking|#hex>.`, "info");
				}
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Prompt settings could not be saved.", "error"); }
		},
	});
}
