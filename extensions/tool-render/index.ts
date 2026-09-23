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
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { expansionHint } from "../../lib/tool-ui.ts";
import { PlainOutput } from "../../lib/output.ts";
import { disposeSyntax, highlightSyntax, initializeSyntax } from "../../lib/syntax.ts";
import { commandPurpose, commandPurposeParameter, COMMAND_PURPOSE_GUIDELINE } from "../../lib/tool-purpose.ts";
import { BASH_STYLE, managedBashOwns, type BashStyleRequest } from "../background-jobs/bash-style.ts";
import { closeDanglingLink } from "../../lib/links.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	boundTail,
	fileLink,
	firstLine,
	labelText,
	resultText,
	searchTarget,
	summarize,
	targetFor,
	toAbs,
	verbFor,
	type ToolName,
} from "./render.ts";
import { contentToAddRows, gutterWidth, parseUnifiedPatch, washLine, diffCounts, type DiffRow } from "./diff.ts";
import { commandPanel } from "./command-panel.ts";
import {
	EXPLORATION_TOOLS,
	bindLeaderRerender,
	closeGroup,
	groupState,
	isLeader,
	noteEnd,
	noteStart,
	resetExploration,
	type DisplayRow,
} from "./exploration.ts";

const BULLET = "•";
const BRANCH = "└";
const PATH_TOOLS = new Set<ToolName>(["read", "write", "edit", "ls"]);

/** Truncation can drop an OSC 8 terminator; close it before rendering the next line. */
const fit = (s: string, width: number): string =>
	closeDanglingLink(visibleWidth(s) <= width ? s : truncateToWidth(s, width, "…"));

/** Fit each render to the current width and fall back to plain text on errors. */
class Lines implements Component {
	constructor(
		private readonly build: (width: number) => string[],
		private readonly fallback: string,
	) {}
	render(width: number): string[] {
		if (width <= 0) return [];
		const w = Math.max(1, width);
		try {
			return this.build(w).map((l) => fit(l, w));
		} catch {
			return [fit(this.fallback, w)];
		}
	}
	invalidate(): void {}
}

function bullet(theme: Theme, ctx: any): string {
	return theme.fg(ctx?.isError ? "error" : ctx?.executionStarted && ctx?.isPartial ? "accent" : "muted", BULLET);
}

const runningVerbs: Record<string, string> = { Read: "Reading", Wrote: "Writing", Edited: "Editing", Ran: "Running", Searched: "Searching", Found: "Finding", Listed: "Listing" };

function actionVerb(name: ToolName, ctx: any): string {
	if (ctx?.isError) return `${name === "bash" ? "Command" : name[0]!.toUpperCase() + name.slice(1)} failed`;
	return ctx?.executionStarted && ctx?.isPartial ? runningVerbs[verbFor(name)]! : verbFor(name);
}

function branchBody(theme: Theme, contentLines: string[], width: number): string[] {
	const inner = Math.max(1, width - 4);
	const first = `${theme.fg("dim", `  ${BRANCH} `)}`;
	const rest = "    ";
	return contentLines.map((line, i) => (i === 0 ? first : rest) + fit(line, inner));
}

/** Keep other themes, unsupported grammars and startup fallback native. */
function highlightPreview(code: string, language: string, theme: Theme): string[] | undefined {
	try {
		return (theme.name === "gruvbox-dark" ? highlightSyntax(code, language) : undefined)
			?? highlightCode(code, language);
	} catch {
		return undefined;
	}
}

function bashBody(result: any, opts: any, theme: Theme, width: number, isError = false, language?: string): string[] {
	const { text } = resultText(result);
	if (text.trim().length === 0) return isError ? branchBody(theme, [theme.fg("error", "failed")], width) : [];
	const managed = result?.details?.managed === true;
	const boundary = managed ? text.indexOf("\n\n") : -1;
	let header = boundary >= 0 ? text.slice(0, boundary).split("\n") : [];
	const output = boundary >= 0 ? text.slice(boundary + 2) : text;
	if (managed && !opts?.expanded) {
		const details = result.details;
		const quietSuccess = !isError && details.status === "completed" && details.exitCode === 0 && !details.signal
			&& !details.more && !details.lost && header.length === 2;
		if (quietSuccess) {
			const duration = header[0]?.match(/ · completed · ([^·]+) · exit 0$/)?.[1]?.trim();
			header = duration && duration !== "0s" ? [duration] : [];
		} else {
			// The job ID remains actionable; output cursors are only useful expanded.
			header = header.map((line) => line.replace(/^(Job: \S+) · cursor: \d+/, "$1"));
		}
	}
	const { lines, omitted } = boundTail(output, opts?.expanded ? 200 : 8);
	const failed = isError || ["failed", "timed-out", "interrupted"].includes(result?.details?.status);
	const body: string[] = header.map((line) => theme.fg(failed ? "error" : "muted", line));
	if (omitted > 0) body.push(theme.fg("dim", `… +${omitted} lines · ${expansionHint()}`));
	const highlighted = !isError && language ? highlightPreview(lines.join("\n"), language, theme) : undefined;
	for (const [index, l] of lines.entries()) {
		const colored = highlighted?.[index] ?? theme.fg(isError ? "error" : "toolOutput", l);
		body.push(...(isError ? wrapTextWithAnsi(colored, Math.max(1, width - 4)) : [colored]));
	}
	return branchBody(theme, body, width);
}

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
			const out = highlightPreview(contents.join("\n"), lang, theme);
			if (out?.length === rows.length) hl = out;
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

function countLabel(theme: Theme, added: number, removed: number): string {
	const parts = [theme.fg("toolDiffAdded", `+${added}`)];
	if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
	return `${theme.fg("dim", "(")}${parts.join(" ")}${theme.fg("dim", ")")}`;
}

/** Render edit/write headlines with the result so patch counts are available. */
function diffHeadline(
	name: ToolName,
	theme: Theme,
	ctx: any,
	width: number,
	count?: { added: number; removed: number },
): string {
	const verbText = actionVerb(name, ctx);
	const verb = theme.bold(theme.fg("text", verbText));
	const label = count ? countLabel(theme, count.added, count.removed) : "";
	const overhead = 3 + verbText.length + (label ? 1 + visibleWidth(label) : 0);
	const a = ctx?.args;
	const target = labelText(targetFor(name, a));
	const parts = [bullet(theme, ctx), verb];
	if (target) {
		const colored = theme.fg("muted", fit(target, Math.max(3, width - overhead)));
		parts.push(fileLink(colored, toAbs(String(a?.path ?? "."), ctx?.cwd ?? process.cwd())));
	}
	if (label) parts.push(label);
	return parts.join(" ");
}

/** Reserve result counts before clipping the subject, so long paths remain useful. */
function explorationRow(row: DisplayRow, theme: Theme, width: number, cwd: string): string {
	const verbText = row.status === "pending" ? runningVerbs[row.verb] ?? row.verb : row.verb;
	const verb = theme.fg(row.status === "pending" ? "accent" : row.status === "error" ? "error" : "muted", verbText);
	const available = Math.max(0, width - visibleWidth(verbText) - 1);
	const suffixWidth = Math.max(0, Math.min(visibleWidth(row.suffix ?? "") + 3, Math.floor(available * 0.65)));
	const suffix = row.suffix && suffixWidth >= 5 ? theme.fg(row.status === "error" ? "error" : "dim", fit(` · ${row.suffix}`, suffixWidth)) : "";
	const detail = fit(row.detail, Math.max(0, available - visibleWidth(suffix)));
	const subject = theme.fg("text", row.filePath ? fileLink(detail, toAbs(row.filePath, cwd)) : detail);
	return `${verb} ${subject}${suffix}`;
}

function explorationBlock(rows: DisplayRow[], active: boolean, theme: Theme, width: number, cwd: string): string[] {
	const dot = theme.fg(rows.some((row) => row.status === "error") ? "error" : active ? "accent" : "muted", BULLET);
	const title = theme.bold(theme.fg("text", active ? "Exploring" : "Explored"));
	const inner = Math.max(1, width - 4);
	const lines = [fit(`${dot} ${title}`, width)];
	rows.forEach((row, i) => {
		const connector = theme.fg("dim", `  ${i === rows.length - 1 ? "└" : "├"} `);
		lines.push(connector + explorationRow(row, theme, inner, cwd));
	});
	return lines;
}

function standaloneExploration(name: ToolName, result: any, theme: Theme, ctx: any, width: number): string[] {
	const args = ctx?.args;
	const target = name === "grep" || name === "find" ? searchTarget(args) : labelText(targetFor(name, args));
	const row: DisplayRow = { verb: ctx?.isError ? actionVerb(name, ctx) : verbFor(name), detail: target,
		status: ctx?.isError ? "error" : ctx?.executionStarted && ctx?.isPartial ? "pending" : "done",
		filePath: PATH_TOOLS.has(name) ? String(args?.path ?? args?.dir ?? ".") : undefined,
		suffix: ctx?.isError || ctx?.isPartial ? undefined : summarize(name, result, args) };
	const head = `${bullet(theme, ctx)} ${explorationRow(row, theme, Math.max(1, width - 2), ctx?.cwd ?? process.cwd())}`;
	if (ctx?.isError) {
		const msg = new PlainOutput().push(resultText(result).text).trim().slice(0, 1200) || "failed";
		return [head, ...branchBody(theme, wrapTextWithAnsi(theme.fg("error", msg), Math.max(1, width - 4)), width)];
	}
	return [head];
}

function bindExploration(ctx: any): void {
	bindLeaderRerender(ctx?.toolCallId, () => { try { ctx.invalidate(); } catch { /* detached view */ } });
}

/** Highlight before wrapping so strings and heredocs retain their shell context. */
function highlightCommand(command: string, theme: Theme): string {
	let colored = command;
	// Bound parser work for unusually large native Bash calls. The managed tool
	// already limits commands to this size; longer commands keep a plain preview.
	if (command.length <= 16_000) {
		try { colored = highlightPreview(command, "bash", theme)?.join("\n") ?? command; }
		catch { /* A highlighting failure must not hide the command. */ }
	}
	// Restore the base foreground after highlighted tokens, without painting over
	// their colors or allowing a token color to leak into the following output.
	const base = theme.getFgAnsi?.("text") ?? "\x1b[39m";
	return theme.fg("text", colored.replace(/\x1b\[39m/g, base));
}

function makeRenderCall(name: ToolName) {
	return (args: any, theme: Theme, ctx: any): Component => {
		// Native Pi has no result slot before the first result. The call slot owns
		// running exploration; completion moves the block to the result slot.
		if (EXPLORATION_TOOLS.has(name)) return new Lines((width) => {
			if (!ctx?.executionStarted || !ctx?.isPartial) return [];
			const state = groupState(ctx?.toolCallId);
			if (!state) return standaloneExploration(name, undefined, theme, ctx, width);
			if (!isLeader(ctx?.toolCallId)) return [];
			bindExploration(ctx);
			return explorationBlock(state.rows, state.active, theme, width, ctx?.cwd ?? process.cwd());
		}, "");
		// Completed edit/write counts need the result patch; pending writes do not
		// claim the intended additions have already succeeded.
		if (name === "edit" || name === "write") return new Lines((width) => ctx?.executionStarted && ctx?.isPartial ? [diffHeadline(name, theme, ctx, width)] : [], "");
		const a = args ?? ctx?.args;
		const build = (width: number): string[] => {
			const verbText = actionVerb(name, ctx);
			const verb = theme.bold(theme.fg("text", verbText));
			if (name === "bash") {
				const title = ctx?.isError ? "Command failed"
					: ctx?.isPartial && !ctx?.executionStarted ? "Command" : `${verbText} command`;
				const purpose = commandPurpose(a?.purpose);
				const header = theme.fg(ctx?.isError ? "error" : "muted", `${BULLET} ${title}`)
					+ (purpose ? theme.fg("dim", " · ") + theme.fg("text", purpose) : "");
				// Tabs become fixed display indentation, never terminal cursor movement.
				// Preserve the actual tool argument, including its shell whitespace.
				const command = new PlainOutput().push(String(a?.command ?? "")).replace(/\t/g, "    ").replace(/^\n+|\n+$/g, "");
				if (!command.trim()) return [header];
				return [header, ...commandPanel(highlightCommand(command, theme), width, theme, !!ctx?.expanded)];
			}
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
				if (opts?.isPartial) return []; // the call slot owns the running state
				if (opts?.expanded) {
					const heading = standaloneExploration(name, result, theme, ctx, width);
					const language = name === "read" ? getLanguageFromPath(String(ctx?.args?.path ?? "")) : undefined;
					return [...(ctx?.isError ? heading.slice(0, 1) : heading), ...bashBody(result, opts, theme, width, !!ctx?.isError, language)];
				}
				const st = groupState(ctx?.toolCallId);
				if (ctx?.isError) {
					const failure = standaloneExploration(name, result, theme, ctx, width);
					return st && isLeader(ctx?.toolCallId) ? [...explorationBlock(st.rows, st.active, theme, width, ctx?.cwd ?? process.cwd()), ...failure] : failure;
				}
				if (!st) return standaloneExploration(name, result, theme, ctx, width);
				if (!isLeader(ctx?.toolCallId)) return []; // follower — renders nothing
				bindExploration(ctx);
				return explorationBlock(st.rows, st.active, theme, width, ctx?.cwd ?? process.cwd());
			}, summarize(name, result, ctx?.args) || "done");
		}
		const build = (width: number): string[] => {
			// edit/write own their headline here (renderCall is empty) so the +/-
			// count can be read from the result patch.
			if (name === "edit" || name === "write") {
				if (opts?.isPartial) return []; // do not claim intended writes succeeded
				if (ctx?.isError) {
					return [diffHeadline(name, theme, ctx, width), ...bashBody(result, opts, theme, width, true)];
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
				return bashBody(result, opts, theme, width, true);
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
		const bashStyle = { renderShell: "self" as const, renderCall: makeRenderCall("bash"), renderResult: makeRenderResult("bash") };
		pi.events?.on(BASH_STYLE, (data) => {
			const request = data as BashStyleRequest;
			if (typeof request?.provide === "function") request.provide(bashStyle, () => {});
		});
		const factories: Record<ToolName, (dir: string) => any> = {
			read: createReadToolDefinition,
			write: createWriteToolDefinition,
			edit: createEditToolDefinition,
			bash: createBashToolDefinition,
			grep: createGrepToolDefinition,
			find: createFindToolDefinition,
			ls: createLsToolDefinition,
		};
		// Overrides replace execution as well as rendering, so they must resolve
		// relative paths against the session's cwd. Registering by name replaces the
		// previous definition, so rebinding on session_start is idempotent.
		let boundCwd: string | undefined;
		let boundBash = false;
		const registerOverrides = (cwd: string, includeBash = false): void => {
			if (boundCwd === cwd && (!includeBash || boundBash)) return;
			boundBash = includeBash;
			boundCwd = cwd;
			for (const name of Object.keys(factories) as ToolName[]) {
				try {
					if (name === "bash" && (!includeBash || managedBashOwns(pi, bashStyle))) continue;
					const definition: ToolDefinition<any> = factories[name](cwd);
					// Purpose is model-written display metadata. Keep it optional for
					// historical calls, and never pass it to the native executor.
					const purposeMetadata: Partial<ToolDefinition<any>> = name === "bash" ? {
						parameters: { ...definition.parameters, properties: { purpose: commandPurposeParameter, ...definition.parameters.properties } },
						promptGuidelines: [...(definition.promptGuidelines ?? []), COMMAND_PURPOSE_GUIDELINE],
						execute: (id, args, signal, update, context) => {
							const { purpose: _purpose, ...commandArgs } = args as Record<string, unknown>;
							return definition.execute(id, commandArgs, signal, update, context);
						},
					} : {};
					pi.registerTool({
						...definition,
						...purposeMetadata,
						renderShell: "self",
						renderCall: makeRenderCall(name),
						renderResult: makeRenderResult(name),
					});
				} catch {
					// Leave this tool as pi's built-in if the override can't be registered.
				}
			}
		};

		// Defer standalone bash until session_start, after all executor owners load.
		// Register other overrides immediately before the first session event,
		// then rebind to the authoritative session cwd (which /resume can change).
		registerOverrides(process.cwd());

		// Exploration grouping: track runs of read/grep/find/ls, broken by any
		// other tool or a new assistant message.
		resetExploration();
		pi.on("session_start", async (_event: any, ctx: any) => {
			if (typeof ctx?.cwd === "string" && ctx.cwd) registerOverrides(ctx.cwd, true);
			resetExploration();
			// Pi awaits public lifecycle handlers. Registration stays synchronous;
			// repeated starts reuse this extension's cached highlighter.
			if (ctx?.mode === "tui") await initializeSyntax();
		});
		pi.on("tool_execution_start", (event: any) => {
			if (EXPLORATION_TOOLS.has(event?.toolName)) noteStart(event.toolCallId, event.toolName, event.args);
			else closeGroup();
		});
		pi.on("tool_execution_end", (event: any) => {
			if (EXPLORATION_TOOLS.has(event?.toolName)) {
				const count = event.isError
					? `failed: ${labelText(firstLine(resultText(event.result).text)).slice(0, 240) || "unknown error"}`
					: summarize(event.toolName as ToolName, event.result, undefined);
				noteEnd(event.toolCallId, !!event.isError, count);
			}
		});
		pi.on("message_start", (event: any) => {
			if (event?.message?.role === "assistant") closeGroup();
		});
		pi.on("agent_end", () => closeGroup());
		pi.on("session_tree", () => resetExploration());
		pi.on("session_shutdown", () => {
			resetExploration();
			disposeSyntax();
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
