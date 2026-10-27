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
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { expansionHint } from "../../lib/tool-ui.ts";
import { PlainOutput } from "../../lib/output.ts";
import { disposeSyntax, initializeSyntax } from "../../lib/syntax.ts";
import {
	changePurposeParameter,
	commandPurpose,
	commandPurposeParameter,
	COMMAND_PURPOSE_GUIDELINE,
	purposeArgument,
	toolPurpose,
	toolPurposeParameter,
	withoutPurpose,
} from "../../lib/tool-purpose.ts";
import { BASH_STYLE, managedBashOwns, type BashStyleRequest } from "../background-jobs/bash-style.ts";
import { assertSearchRoot, BROAD_ROOT_NOTE } from "../../lib/search-root.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	compactPath,
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
import { codemodeRestyler } from "./codemode.ts";
import { commandPanel } from "./command-panel.ts";
import { baseRevision, fit, Lines } from "./lines.ts";
import { executeWriteWithDiff } from "./write-diff.ts";
import { bashOutcome, type BashOutcome } from "./bash-status.ts";
import { BULLET, bashBody, bashStatus, branchBody, clearBashTimes, highlightPreview, highlightSource, noteBashTime, wrapRows } from "./card.ts";
import {
	EXPLORATION_TOOLS,
	bindLeaderRerender,
	closeGroup,
	explorationRevision,
	groupOf,
	groupState,
	noteEnd,
	noteStart,
	resetExploration,
	previewRows,
	restoreExploration,
	type DisplayRow,
} from "./exploration.ts";

const PATH_TOOLS = new Set<ToolName>(["read", "write", "edit", "ls"]);
/** Calls whose headline shows a live elapsed time while running. */
const TIMED_TOOLS = new Set(["bash", "codemode"]);

/** Grouped rows also depend on sibling calls, which change without recreating the leader. */
const groupedRevision = (id: string | undefined) => (): string => `${baseRevision()}:${explorationRevision(id)}`;

function bullet(theme: Theme, ctx: any): string {
	return theme.fg(ctx?.isError ? "error" : ctx?.executionStarted && ctx?.isPartial ? "accent" : "muted", BULLET);
}

const runningVerbs: Record<string, string> = { Read: "Reading", Wrote: "Writing", Edited: "Editing", Ran: "Running", Searched: "Searching", Found: "Finding", Listed: "Listing" };

function actionVerb(name: ToolName, ctx: any): string {
	if (ctx?.isError) return `${name === "bash" ? "Command" : name[0]!.toUpperCase() + name.slice(1)} failed`;
	return ctx?.executionStarted && ctx?.isPartial ? runningVerbs[verbFor(name)]! : verbFor(name);
}

/** Width-independent work runs once per card, not once per width or frame. */
function memo<T>(compute: () => T): () => T {
	let done = false;
	let value: T;
	return () => {
		if (!done) {
			value = compute();
			done = true;
		}
		return value;
	};
}

interface DiffView {
	shown: DiffRow[];
	omitted: number;
	gutter: number;
	highlighted: () => string[];
}

/** Bound the rows first, so collapsed cards never highlight content they hide. */
function diffView(rows: DiffRow[], path: string, theme: Theme, expanded: boolean, hidden = 0): DiffView {
	const shown = rows.slice(0, expanded ? 400 : 12);
	return {
		shown,
		omitted: rows.length - shown.length + hidden,
		gutter: gutterWidth(rows),
		highlighted: memo(() => {
			const contents = shown.map((r) => r.content);
			const lang = path ? getLanguageFromPath(path) : undefined;
			const out = lang ? highlightPreview(contents.join("\n"), lang, theme) : undefined;
			return out?.length === shown.length ? out : contents;
		}),
	};
}

function diffBody(view: DiffView, theme: Theme, width: number, expanded: boolean): string[] {
	const { shown, omitted, gutter: gw } = view;
	if (shown.length === 0) return [];
	const addBg = theme.getBgAnsi("toolSuccessBg");
	const delBg = theme.getBgAnsi("toolErrorBg");
	const hl = view.highlighted();
	const inner = Math.max(1, width - 2); // 2-space left margin sits outside the wash
	const indent = " ".repeat(gw + 3);
	const lines = shown.flatMap((row, i) => {
		const num = theme.fg("dim", String(row.num).padStart(gw));
		const code = hl[i] ?? row.content;
		const marker = row.kind === "ctx" ? " "
			: theme.fg(row.kind === "add" ? "toolDiffAdded" : "toolDiffRemoved", row.kind === "add" ? "+" : "-");
		// Expanded diffs wrap long lines below the code column instead of clipping.
		const pieces = expanded ? wrapRows(code, inner - indent.length) : [code];
		return pieces.map((piece, j) => {
			const content = fit(`${j === 0 ? `${num} ${marker} ` : indent}${piece}`, inner);
			if (row.kind === "ctx") return `  ${content}`;
			return `  ${washLine(row.kind === "add" ? addBg : delBg, content, visibleWidth(content), inner)}`;
		});
	});
	if (omitted > 0) lines.push(`  ${fit(theme.fg("dim", `… +${omitted} lines · ${expanded ? "preview limit" : expansionHint()}`), inner)}`);
	return lines;
}

function countLabel(theme: Theme, added: number, removed: number): string {
	const parts = [theme.fg("toolDiffAdded", `+${added}`)];
	if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
	return `${theme.fg("dim", "(")}${parts.join(" ")}${theme.fg("dim", ")")}`;
}

/** Secondary intent never crowds out a useful target or result count. */
function purposeSuffix(purpose: string | undefined, width: number, theme: Theme): string {
	if (!purpose || width < 3 + Math.min(12, visibleWidth(purpose))) return "";
	return theme.fg("dim", " · ") + theme.fg("text", fit(purpose, width - 3));
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/** Size of a streamed write or edit; partial arguments may still be growing. */
function pendingProgress(name: ToolName, args: any): string {
	if (name === "write") return typeof args?.content === "string" ? plural(contentToAddRows(args.content).length, "line") : "";
	const edits = Array.isArray(args?.edits) ? args.edits.length : typeof args?.oldText === "string" ? 1 : 0;
	return edits ? plural(edits, "edit") : "";
}

/** Render edit/write headlines with the result so patch counts are available. */
function diffHeadline(
	name: ToolName,
	theme: Theme,
	ctx: any,
	width: number,
	count?: { added: number; removed: number },
): string {
	// Streaming arguments already describe the intended change, before execution.
	const pending = ctx?.isPartial && !ctx?.isError;
	const verbText = pending ? runningVerbs[verbFor(name)]! : actionVerb(name, ctx);
	const verb = theme.bold(theme.fg("text", verbText));
	const progress = pending ? pendingProgress(name, ctx?.args) : "";
	const label = count ? countLabel(theme, count.added, count.removed) : progress ? theme.fg("dim", `· ${progress}`) : "";
	const overhead = 3 + verbText.length + (label ? 1 + visibleWidth(label) : 0);
	const a = ctx?.args;
	const target = labelText(targetFor(name, a));
	const purpose = toolPurpose(purposeArgument(a), [a?.path]);
	const caption = purposeSuffix(purpose, Math.floor(Math.max(0, width - overhead) * 0.55), theme);
	const parts = [bullet(theme, ctx), verb];
	if (target) {
		const colored = theme.fg("muted", compactPath(target, Math.max(3, width - overhead - visibleWidth(caption))));
		parts.push(fileLink(colored, toAbs(String(a?.path ?? "."), ctx?.cwd ?? process.cwd())));
	}
	if (label) parts.push(label);
	return parts.join(" ") + caption;
}

/** Reserve result counts before clipping the subject, so long paths remain useful. */
function explorationRow(row: DisplayRow, theme: Theme, width: number, cwd: string): string {
	const verbText = row.status === "pending" ? runningVerbs[row.verb] ?? row.verb : row.verb;
	const verb = theme.fg(row.status === "pending" ? "accent" : row.status === "error" ? "error" : "muted", verbText);
	const available = Math.max(0, width - visibleWidth(verbText) - 1);
	const suffixWidth = Math.max(0, Math.min(visibleWidth(row.suffix ?? "") + 3, Math.floor(available * 0.65)));
	const suffix = row.suffix && suffixWidth >= 5 ? theme.fg(row.status === "error" ? "error" : "dim", fit(` · ${row.suffix}`, suffixWidth)) : "";
	const detailWidth = Math.max(0, available - visibleWidth(suffix));
	const caption = purposeSuffix(row.purpose, Math.floor(detailWidth * 0.55), theme);
	const targetWidth = Math.max(0, detailWidth - visibleWidth(caption));
	const detail = row.filePath ? compactPath(row.detail, targetWidth) : fit(row.detail, targetWidth);
	const subject = theme.fg("text", row.filePath ? fileLink(detail, toAbs(row.filePath, cwd)) : detail);
	return `${verb} ${subject}${caption}${suffix}`;
}

function explorationBlock(rows: DisplayRow[], active: boolean, theme: Theme, width: number, cwd: string): string[] {
	const dot = theme.fg(rows.some((row) => row.status === "error") ? "error" : active ? "accent" : "muted", BULLET);
	const title = theme.bold(theme.fg("text", active ? "Exploring" : "Explored"));
	const inner = Math.max(1, width - 4);
	const sharedPurpose = rows[0]?.purpose && rows.every((row) => row.purpose === rows[0]!.purpose) ? rows[0].purpose : undefined;
	const lines = [fit(`${dot} ${title}${purposeSuffix(sharedPurpose, Math.max(0, width - visibleWidth(title) - 2), theme)}`, width)];
	const preview = previewRows(rows);
	preview.rows.forEach((row, i) => {
		const connector = theme.fg("dim", `  ${!preview.omitted && i === preview.rows.length - 1 ? "└" : "├"} `);
		lines.push(connector + explorationRow(sharedPurpose ? { ...row, purpose: undefined } : row, theme, inner, cwd));
	});
	if (preview.omitted) {
		const counts = [preview.failed ? `${preview.failed} failed` : "", preview.pending ? `${preview.pending} running` : ""].filter(Boolean);
		const omitted = `… ${preview.omitted} more ${preview.omitted === 1 ? "step" : "steps"}${counts.length ? ` (${counts.join(", ")})` : ""} · ${expansionHint()}`;
		lines.push(theme.fg("dim", "  └ ") + theme.fg(preview.failed ? "error" : "dim", fit(omitted, inner)));
	}
	return lines;
}

function standaloneExploration(name: ToolName, result: any, theme: Theme, ctx: any, width: number): string[] {
	const args = ctx?.args;
	const target = name === "grep" || name === "find" ? searchTarget(args) : labelText(targetFor(name, args));
	const row: DisplayRow = { verb: ctx?.isError ? actionVerb(name, ctx) : verbFor(name), detail: target,
		status: ctx?.isError ? "error" : ctx?.executionStarted && ctx?.isPartial ? "pending" : "done",
		filePath: PATH_TOOLS.has(name) ? String(args?.path ?? args?.dir ?? ".") : undefined,
		suffix: ctx?.isError || ctx?.isPartial ? undefined : summarize(name, result, args),
		purpose: toolPurpose(purposeArgument(args), [args?.path, args?.pattern, args?.query, args?.name]) };
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

function makeRenderCall(name: ToolName) {
	return (args: any, theme: Theme, ctx: any): Component => {
		// Native Pi has no result slot before the first result. The call slot owns
		// running exploration; completion moves the block to the result slot.
		if (EXPLORATION_TOOLS.has(name)) return new Lines((width) => {
			if (!ctx?.executionStarted || !ctx?.isPartial) return [];
			const group = groupOf(ctx?.toolCallId);
			if (!group) return standaloneExploration(name, undefined, theme, ctx, width);
			if (group.leaderId !== ctx?.toolCallId) return [];
			const state = groupState(ctx?.toolCallId)!;
			bindExploration(ctx);
			return explorationBlock(state.rows, state.active, theme, width, ctx?.cwd ?? process.cwd());
		}, "", { volatile: !!ctx?.isPartial, revision: groupedRevision(ctx?.toolCallId) });
		// Completed edit/write counts need the result patch. Streaming and running
		// cards show the intended size without claiming any change succeeded.
		if (name === "edit" || name === "write") return new Lines((width) => ctx?.isPartial ? [diffHeadline(name, theme, ctx, width)] : [], "", { volatile: !!ctx?.isPartial });
		const a = args ?? ctx?.args;
		// Tabs become fixed display indentation, never terminal cursor movement.
		// Preserve the actual tool argument, including its shell whitespace.
		const command = name === "bash"
			? new PlainOutput().push(String(a?.command ?? "")).replace(/\t/g, "    ").replace(/^\n+|\n+$/g, "")
			: "";
		const highlighted = memo(() => highlightSource(command, "bash", theme));
		const build = (width: number): string[] => {
			const verbText = actionVerb(name, ctx);
			const verb = theme.bold(theme.fg("text", verbText));
			if (name === "bash") {
				// The result renderer records the outcome in shared row state.
				const outcome = ctx?.state?.bashOutcome as BashOutcome | undefined;
				const running = !!(ctx?.executionStarted && ctx?.isPartial);
				const failed = !!ctx?.isError || (!running && outcome?.state === "failed");
				const title = failed ? "Command failed"
					: ctx?.isPartial && !ctx?.executionStarted ? "Command" : `${verbText} command`;
				const purpose = commandPurpose(purposeArgument(a));
				const left = theme.fg(failed ? "error" : "muted", `${BULLET} ${title}`)
					+ (purpose ? theme.fg("dim", " · ") + theme.fg("text", purpose) : "");
				const status = bashStatus(theme, outcome, running, ctx?.toolCallId);
				// Clip the caption, never the status.
				const header = status ? fit(left, Math.max(1, width - visibleWidth(status))) + status : left;
				if (!command.trim()) return [header];
				return [header, ...commandPanel(highlighted(), width, theme, !!ctx?.expanded)];
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
		return new Lines(build, `${verbFor(name)} ${targetFor(name, a)}`.trim(), { volatile: !!ctx?.isPartial });
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
				const group = groupOf(ctx?.toolCallId);
				if (ctx?.isError) {
					const failure = standaloneExploration(name, result, theme, ctx, width);
					if (!group || group.leaderId !== ctx?.toolCallId) return failure;
					const st = groupState(ctx?.toolCallId)!;
					return [...explorationBlock(st.rows, st.active, theme, width, ctx?.cwd ?? process.cwd()), ...failure];
				}
				if (!group) return standaloneExploration(name, result, theme, ctx, width);
				// Hidden followers must not rebuild/coalesce the whole group on each
				// repaint: doing so makes large saved groups quadratic to render.
				if (group.leaderId !== ctx?.toolCallId) return [];
				const st = groupState(ctx?.toolCallId)!;
				bindExploration(ctx);
				return explorationBlock(st.rows, st.active, theme, width, ctx?.cwd ?? process.cwd());
			}, summarize(name, result, ctx?.args) || "done", { volatile: !!opts?.isPartial, revision: groupedRevision(ctx?.toolCallId) });
		}
		// Pi creates the call component first and renders both later, so the
		// call headline can show the outcome recorded here.
		if (name === "bash" && ctx?.state) ctx.state.bashOutcome = bashOutcome(result, !!ctx.isError);
		const diff = memo(() => {
			const details = result?.details;
			const patch = typeof details?.patch === "string" ? details.patch : undefined;
			const content = typeof ctx?.args?.content === "string" ? ctx.args.content : "";
			// Overwrites carry a patch against the previous content; new files do not.
			const rows = patch !== undefined ? parseUnifiedPatch(patch) : name === "write" ? contentToAddRows(content) : [];
			const counted = Number.isSafeInteger(details?.added) && Number.isSafeInteger(details?.removed)
				? { added: details.added as number, removed: details.removed as number } : diffCounts(rows);
			const hidden = Number.isSafeInteger(details?.omittedRows) ? Math.max(0, details.omittedRows as number) : 0;
			return { counts: counted, view: diffView(rows, String(ctx?.args?.path ?? ""), theme, !!opts?.expanded, hidden) };
		});
		const build = (width: number): string[] => {
			// edit/write own their headline here (renderCall is empty) so the +/-
			// count can be read from the result patch.
			if (name === "edit" || name === "write") {
				if (opts?.isPartial) return []; // do not claim intended writes succeeded
				if (ctx?.isError) {
					return [diffHeadline(name, theme, ctx, width), ...bashBody(result, opts, theme, width, true)];
				}
				const { counts, view } = diff();
				return [diffHeadline(name, theme, ctx, width, counts), ...diffBody(view, theme, width, !!opts?.expanded)];
			}
			if (ctx?.isError) {
				return bashBody(result, opts, theme, width, true);
			}
			if (name === "bash") return bashBody(result, opts, theme, width);
			if (opts?.isPartial) return branchBody(theme, [theme.fg("muted", "…")], width);
			const summary = summarize(name, result, ctx?.args);
			return summary ? branchBody(theme, [theme.fg("muted", summary)], width) : [];
		};
		return new Lines(build, summarize(name, result, ctx?.args) || "done", { volatile: !!opts?.isPartial });
	};
}

/** Record exit code and duration with the result, so saved history keeps the headline status. */
async function executeTimedBash(definition: ToolDefinition<any>, ...[id, args, signal, update, context]: Parameters<ToolDefinition<any>["execute"]>) {
	const started = performance.now();
	const result = await definition.execute(id, args, signal, update, context);
	const exitCode = (result.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
	const details = result.details !== null && typeof result.details === "object" ? result.details : {};
	return { ...result, details: { ...details, durationMs: Math.round(performance.now() - started),
		...(Number.isSafeInteger(exitCode) ? { exitCode } : {}) } };
}

const STRICT_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

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
		const unsubscribeStyle = pi.events?.on(BASH_STYLE, (data) => {
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
					// historical calls, and never pass it (or its saved `reasoning`
					// alias) to the native executor.
					const purposeParameter = name === "bash" ? commandPurposeParameter
						: name === "edit" || name === "write" ? changePurposeParameter : toolPurposeParameter;
					const search = name === "grep" || name === "find";
					const purposeMetadata: Partial<ToolDefinition<any>> = {
						parameters: { ...definition.parameters, properties: { purpose: purposeParameter, ...definition.parameters.properties } },
						// Pi sends strict schemas only to tools that opt in; keep native
						// opt-ins and prefer strict sampling for the added field.
						constrainedSampling: definition.constrainedSampling ?? STRICT_SAMPLING,
						...(search ? { description: `${definition.description} ${BROAD_ROOT_NOTE}` } : {}),
						...(name === "bash" ? { promptGuidelines: [...(definition.promptGuidelines ?? []), COMMAND_PURPOSE_GUIDELINE] } : {}),
						execute: async (id, args, signal, update, context) => {
							const toolArgs = withoutPurpose(args as Record<string, unknown>);
							if (name === "write") return executeWriteWithDiff(cwd, id, toolArgs, signal, update, context);
							if (name === "bash") return executeTimedBash(definition, id, toolArgs, signal, update, context);
							if (search) await assertSearchRoot(name, toolArgs.path, context?.cwd || cwd);
							return definition.execute(id, toolArgs, signal, update, context);
						},
					};
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
		const restyleCodemode = codemodeRestyler(pi);

		// Exploration grouping: track runs of read/grep/find/ls, broken by any
		// other tool or a new assistant message.
		resetExploration();
		const restoreGroups = (ctx: any): void => {
			try {
				// Match Pi's rendered history so a compacted-away leader cannot hide
				// a surviving follower. Missing host data leaves ordinary tool cards.
				const entries = ctx?.sessionManager?.buildContextEntries?.();
				if (Array.isArray(entries)) restoreExploration(entries);
				else resetExploration();
			} catch { resetExploration(); }
		};
		pi.on("session_start", async (_event: any, ctx: any) => {
			if (typeof ctx?.cwd === "string" && ctx.cwd) registerOverrides(ctx.cwd, true);
			restyleCodemode();
			restoreGroups(ctx);
			// Pi awaits public lifecycle handlers. Registration stays synchronous;
			// repeated starts reuse this extension's cached highlighter.
			if (ctx?.mode === "tui") await initializeSyntax();
		});
		pi.on("tool_execution_start", (event: any) => {
			if (TIMED_TOOLS.has(event?.toolName)) noteBashTime(event.toolCallId, "start");
			if (EXPLORATION_TOOLS.has(event?.toolName)) noteStart(event.toolCallId, event.toolName, event.args);
			else closeGroup();
		});
		pi.on("tool_execution_end", (event: any) => {
			if (TIMED_TOOLS.has(event?.toolName)) noteBashTime(event.toolCallId, "end");
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
		pi.on("session_tree", (_event, ctx) => restoreGroups(ctx));
		pi.on("session_compact", (_event, ctx) => restoreGroups(ctx));
		pi.on("session_shutdown", () => {
			unsubscribeStyle?.();
			resetExploration();
			clearBashTimes();
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
