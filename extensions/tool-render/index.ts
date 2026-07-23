/**
 * tool-render — restyles pi's built-in tools into Codex-style transcript blocks:
 *
 *   • Ran bun test
 *     └ 12 pass  0 fail
 *
 *   • Edited src/auth.ts (+1 -1)
 *     41 - return a - b
 *     41 + return a + b
 *
 * A subtle `•` status bullet + bold verb + target on line 1, then the output or
 * diff indented under a dim `└` branch. The command/path is shown once (in the
 * headline) — never duplicated.
 *
 * Safety: execution is untouched (each tool spreads the exported
 * createXToolDefinition, preserving execute/params/details); only rendering
 * changes. Every line is width-fit and each component catches its own errors, so
 * a display bug degrades to one plain line rather than crashing the TUI.
 * Reversible via ~/.pi/agent/tool-render.json { "enabled": false } or
 * /tool-render off + /reload. No monkey-patching.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	getLanguageFromPath,
	highlightCode,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	boundTail,
	fileLink,
	firstLine,
	resultText,
	summarize,
	targetFor,
	toAbs,
	verbFor,
	type ToolName,
} from "./render.ts";
import { contentToAddRows, gutterWidth, parseUnifiedPatch, washLine, diffCounts, type DiffRow } from "./diff.ts";
import {
	EXPLORATION_TOOLS,
	bindLeaderRerender,
	closeGroup,
	groupState,
	isLeader,
	noteEnd,
	noteStart,
	resetExploration,
	type Activity,
} from "./exploration.ts";

const BULLET = "•";
const BRANCH = "└";
const PATH_TOOLS = new Set<ToolName>(["read", "write", "edit", "ls"]);

/** Hard-fit a (possibly ANSI-colored) line to `width`; never returns wider. */
const fit = (s: string, width: number): string =>
	visibleWidth(s) <= width ? s : truncateToWidth(s, width, "…");

/** A width-safe component: re-fits on resize and can never throw out of render(). */
class Lines implements Component {
	constructor(
		private readonly build: (width: number) => string[],
		private readonly fallback: string,
	) {}
	render(width: number): string[] {
		const w = Math.max(1, width);
		try {
			return this.build(w).map((l) => fit(l, w));
		} catch {
			return [fit(this.fallback, w)];
		}
	}
	invalidate(): void {}
}

/** Subtle status bullet: red on error, otherwise muted (Codex keeps it quiet). */
function bullet(theme: Theme, ctx: any): string {
	return theme.fg(ctx?.isError ? "error" : "muted", BULLET);
}

/** Indent detail lines under a dim `└` branch (Codex style): first line gets the
 *  branch, the rest align beneath it. Content is fit to the remaining width. */
function branchBody(theme: Theme, contentLines: string[], width: number): string[] {
	const inner = Math.max(1, width - 4);
	const first = `${theme.fg("dim", `  ${BRANCH} `)}`;
	const rest = "    ";
	return contentLines.map((line, i) => (i === 0 ? first : rest) + fit(line, inner));
}

/** bash: output only (the command is already in the headline), bounded. */
function bashBody(result: any, opts: any, theme: Theme, width: number): string[] {
	const { text } = resultText(result);
	if (text.trim().length === 0) return [];
	const { lines, omitted } = boundTail(text, opts?.expanded ? 200 : 8);
	const body: string[] = [];
	if (omitted > 0) body.push(theme.fg("dim", `… +${omitted} lines`));
	for (const l of lines) body.push(theme.fg("toolOutput", l));
	return branchBody(theme, body, width);
}

/** Codex-style diff: line-numbered, syntax-highlighted, with a full-width
 *  green/red background wash on added/removed lines. */
function diffBody(rows: DiffRow[], path: string, theme: Theme, width: number, expanded: boolean): string[] {
	if (rows.length === 0) return [];
	const gw = gutterWidth(rows);
	const addBg = theme.getBgAnsi("toolSuccessBg");
	const delBg = theme.getBgAnsi("toolErrorBg");
	const lang = path ? getLanguageFromPath(path) : undefined;
	const contents = rows.map((r) => r.content);
	let hl: string[] = contents;
	if (lang) {
		try {
			const out = highlightCode(contents.join("\n"), lang);
			if (out.length === rows.length) hl = out;
		} catch {
			// keep raw content
		}
	}
	const maxRows = expanded ? 400 : 12;
	const shown = rows.slice(0, maxRows);
	const omitted = rows.length - shown.length;
	const inner = Math.max(1, width - 2); // 2-space left margin sits outside the wash
	const lines = shown.map((row, i) => {
		const num = theme.fg("dim", String(row.num).padStart(gw));
		const code = hl[i] ?? row.content;
		if (row.kind === "ctx") return `  ${fit(`${num}   ${code}`, inner)}`;
		const marker = theme.fg(row.kind === "add" ? "toolDiffAdded" : "toolDiffRemoved", row.kind === "add" ? "+" : "-");
		const content = fit(`${num} ${marker} ${code}`, inner);
		const bg = row.kind === "add" ? addBg : delBg;
		return `  ${washLine(bg, content, visibleWidth(content), inner)}`;
	});
	if (omitted > 0) lines.push(`  ${fit(theme.fg("dim", `… +${omitted} lines`), inner)}`);
	return lines;
}

/** `(+A -B)` count label — additions green, removals red, parens dim (Codex). */
function countLabel(theme: Theme, added: number, removed: number): string {
	const parts = [theme.fg("toolDiffAdded", `+${added}`)];
	if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
	return `${theme.fg("dim", "(")}${parts.join(" ")}${theme.fg("dim", ")")}`;
}

/** `• Edited path (+A -B)` headline for edit/write (rendered result-side so the
 *  count can come from the patch). Omits the count when `count` is undefined. */
function diffHeadline(
	name: ToolName,
	theme: Theme,
	ctx: any,
	width: number,
	count?: { added: number; removed: number },
): string {
	const verbText = verbFor(name);
	const verb = theme.bold(theme.fg("text", verbText));
	const label = count ? countLabel(theme, count.added, count.removed) : "";
	const overhead = 3 + verbText.length + (label ? 1 + visibleWidth(label) : 0);
	const a = ctx?.args;
	const target = String(targetFor(name, a) ?? "");
	const parts = [bullet(theme, ctx), verb];
	if (target) {
		const colored = theme.fg("muted", fit(target, Math.max(3, width - overhead)));
		parts.push(fileLink(colored, toAbs(String(a?.path ?? "."), ctx?.cwd ?? process.cwd())));
	}
	if (label) parts.push(label);
	return parts.join(" ");
}

/** The grouped `• Explored` block (one leader renders it; followers render empty). */
function explorationBlock(activities: Activity[], active: boolean, theme: Theme, width: number): string[] {
	const dot = theme.fg(active ? "accent" : "muted", BULLET);
	const title = theme.bold(theme.fg("text", active ? "Exploring" : "Explored"));
	const inner = Math.max(1, width - 4);
	const lines = [fit(`${dot} ${title}`, width)];
	activities.forEach((act, i) => {
		const connector = theme.fg("dim", `  ${i === activities.length - 1 ? "└" : "├"} `);
		const verb = theme.fg("muted", act.verb);
		const detail = theme.fg(act.status === "error" ? "error" : "text", act.detail);
		lines.push(connector + fit(`${verb} ${detail}`, inner));
	});
	return lines;
}

/** Fallback for an ungrouped exploration call (e.g. after reload): headline + summary. */
function standaloneExploration(name: ToolName, result: any, theme: Theme, ctx: any, width: number): string[] {
	const verb = theme.bold(theme.fg("text", verbFor(name)));
	const target = targetFor(name, ctx?.args);
	const head = target
		? `${bullet(theme, ctx)} ${verb} ${theme.fg("muted", fit(target, Math.max(3, width - (verbFor(name).length + 3))))}`
		: `${bullet(theme, ctx)} ${verb}`;
	if (ctx?.isError) {
		const msg = firstLine(resultText(result).text).trim() || "failed";
		return [head, ...branchBody(theme, [theme.fg("error", msg)], width)];
	}
	const summary = summarize(name, result, ctx?.args);
	return summary ? [head, ...branchBody(theme, [theme.fg("muted", summary)], width)] : [head];
}

function makeRenderCall(name: ToolName) {
	return (args: any, theme: Theme, ctx: any): Component => {
		// Exploration tools show nothing on the call line; the grouped block (or a
		// standalone block) is rendered by the result slot.
		if (EXPLORATION_TOOLS.has(name)) return new Lines(() => [], "");
		// edit/write render their headline result-side (the +/- count needs the patch).
		if (name === "edit" || name === "write") return new Lines(() => [], "");
		const a = args ?? ctx?.args;
		const build = (width: number): string[] => {
			const running = name === "bash" && ctx?.executionStarted && ctx?.isPartial;
			const verbText = name === "bash" && running ? "Running" : verbFor(name);
			const verb = theme.bold(theme.fg("text", verbText));
			const target = targetFor(name, a);
			if (!target) return [`${bullet(theme, ctx)} ${verb}`];
			const shown = fit(target, Math.max(3, width - (verbText.length + 3)));
			const colored = theme.fg("muted", shown);
			const targetPart = PATH_TOOLS.has(name)
				? fileLink(colored, toAbs(String(a?.path ?? a?.dir ?? "."), ctx?.cwd ?? process.cwd()))
				: colored;
			return [`${bullet(theme, ctx)} ${verb} ${targetPart}`];
		};
		return new Lines(build, `${verbFor(name)} ${targetFor(name, a)}`.trim());
	};
}

function makeRenderResult(name: ToolName) {
	return (result: any, opts: any, theme: Theme, ctx: any): Component => {
		if (EXPLORATION_TOOLS.has(name)) {
			return new Lines((width: number): string[] => {
				const st = groupState(ctx?.toolCallId);
				if (!st) return standaloneExploration(name, result, theme, ctx, width);
				if (!isLeader(ctx?.toolCallId)) return []; // follower — renders nothing
				bindLeaderRerender(ctx?.toolCallId, () => {
					try {
						ctx.invalidate();
					} catch {
						// ignore
					}
				});
				return explorationBlock(st.activities, st.active, theme, width);
			}, summarize(name, result, ctx?.args) || "done");
		}
		const build = (width: number): string[] => {
			// edit/write own their headline here (renderCall is empty) so the +/-
			// count can be read from the result patch.
			if (name === "edit" || name === "write") {
				if (ctx?.isError) {
					const msg = firstLine(resultText(result).text).trim() || "failed";
					return [diffHeadline(name, theme, ctx, width), ...branchBody(theme, [theme.fg("error", msg)], width)];
				}
				const rows =
					name === "edit"
						? parseUnifiedPatch(result?.details?.patch ?? "")
						: contentToAddRows(typeof ctx?.args?.content === "string" ? ctx.args.content : "");
				const { added, removed } = diffCounts(rows);
				const head = diffHeadline(name, theme, ctx, width, { added, removed });
				return rows.length > 0
					? [head, ...diffBody(rows, String(ctx?.args?.path ?? ""), theme, width, !!opts?.expanded)]
					: [head];
			}
			if (ctx?.isError) {
				const msg = firstLine(resultText(result).text).trim() || "failed";
				return branchBody(theme, [theme.fg("error", msg)], width);
			}
			if (name === "bash") return bashBody(result, opts, theme, width);
			if (opts?.isPartial) return branchBody(theme, [theme.fg("muted", "…")], width);
			const summary = summarize(name, result, ctx?.args);
			return summary ? branchBody(theme, [theme.fg("muted", summary)], width) : [];
		};
		return new Lines(build, summarize(name, result, ctx?.args) || "done");
	};
}

const configPath = () => join(getAgentDir(), "tool-render.json");

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
		// best-effort; toggling is a convenience, not critical
	}
}

export default function toolRenderExtension(pi: ExtensionAPI): void {
	if (readEnabled()) {
		const cwd = process.cwd();
		const factories: Record<ToolName, (dir: string) => any> = {
			read: createReadToolDefinition,
			write: createWriteToolDefinition,
			edit: createEditToolDefinition,
			bash: createBashToolDefinition,
			grep: createGrepToolDefinition,
			find: createFindToolDefinition,
			ls: createLsToolDefinition,
		};
		for (const name of Object.keys(factories) as ToolName[]) {
			try {
				pi.registerTool({
					...factories[name](cwd),
					renderShell: "self",
					renderCall: makeRenderCall(name),
					renderResult: makeRenderResult(name),
				});
			} catch {
				// Leave this tool as pi's built-in if the override can't be registered.
			}
		}

		// Exploration grouping: track runs of read/grep/find/ls, broken by any
		// other tool or a new assistant message.
		resetExploration();
		pi.on("session_start", () => resetExploration());
		pi.on("tool_execution_start", (event: any) => {
			if (EXPLORATION_TOOLS.has(event?.toolName)) noteStart(event.toolCallId, event.toolName, event.args);
			else closeGroup();
		});
		pi.on("tool_execution_end", (event: any) => {
			if (EXPLORATION_TOOLS.has(event?.toolName)) noteEnd(event.toolCallId, !!event.isError);
		});
		pi.on("message_start", (event: any) => {
			if (event?.message?.role === "assistant") closeGroup();
		});
	}

	pi.registerCommand("tool-render", {
		description: "Toggle Codex-style tool rendering (reload to apply)",
		handler: async (args: string, ctx: any) => {
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				writeEnabled(arg === "on");
				ctx.ui.notify(`tool-render ${arg} — run /reload or restart to apply.`, "info");
			} else {
				ctx.ui.notify(
					`tool-render is currently ${readEnabled() ? "on" : "off"}. Use \`/tool-render on|off\` (reload to apply).`,
					"info",
				);
			}
		},
	});
}
