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
import { visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { expansionHint } from "../../lib/tool-ui.ts";
import { PlainOutput } from "../../lib/output.ts";
import { disposeSyntax, highlightSyntax, initializeSyntax } from "../../lib/syntax.ts";
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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	boundTail,
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
import { commandPanel } from "./command-panel.ts";
import { baseRevision, fit, Lines } from "./lines.ts";
import { executeWriteWithDiff } from "./write-diff.ts";
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

const BULLET = "•";
const BRANCH = "└";
const PATH_TOOLS = new Set<ToolName>(["read", "write", "edit", "ls"]);

/** Grouped rows also depend on sibling calls, which change without recreating the leader. */
const groupedRevision = (): string => `${baseRevision()}:${explorationRevision()}`;

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
	if (omitted > 0) body.push(theme.fg("dim", `… +${omitted} lines · ${opts?.expanded ? "preview limit" : expansionHint()}`));
	const highlighted = !isError && language ? highlightPreview(lines.join("\n"), language, theme) : undefined;
	for (const [index, l] of lines.entries()) {
		const colored = highlighted?.[index] ?? theme.fg(isError ? "error" : "toolOutput", l);
		body.push(...(isError ? wrapTextWithAnsi(colored, Math.max(1, width - 4)) : [colored]));
	}
	return branchBody(theme, body, width);
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
	const lines = shown.map((row, i) => {
		const num = theme.fg("dim", String(row.num).padStart(gw));
		const code = hl[i] ?? row.content;
		if (row.kind === "ctx") return `  ${fit(`${num}   ${code}`, inner)}`;
		const marker = theme.fg(row.kind === "add" ? "toolDiffAdded" : "toolDiffRemoved", row.kind === "add" ? "+" : "-");
		const content = fit(`${num} ${marker} ${code}`, inner);
		const bg = row.kind === "add" ? addBg : delBg;
		return `  ${washLine(bg, content, visibleWidth(content), inner)}`;
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
			const group = groupOf(ctx?.toolCallId);
			if (!group) return standaloneExploration(name, undefined, theme, ctx, width);
			if (group.leaderId !== ctx?.toolCallId) return [];
			const state = groupState(ctx?.toolCallId)!;
			bindExploration(ctx);
			return explorationBlock(state.rows, state.active, theme, width, ctx?.cwd ?? process.cwd());
		}, "", { volatile: !!ctx?.isPartial, revision: groupedRevision });
		// Completed edit/write counts need the result patch. Streaming and running
		// cards show the intended size without claiming any change succeeded.
		if (name === "edit" || name === "write") return new Lines((width) => ctx?.isPartial ? [diffHeadline(name, theme, ctx, width)] : [], "", { volatile: !!ctx?.isPartial });
		const a = args ?? ctx?.args;
		// Tabs become fixed display indentation, never terminal cursor movement.
		// Preserve the actual tool argument, including its shell whitespace.
		const command = name === "bash"
			? new PlainOutput().push(String(a?.command ?? "")).replace(/\t/g, "    ").replace(/^\n+|\n+$/g, "")
			: "";
		const highlighted = memo(() => highlightCommand(command, theme));
		const build = (width: number): string[] => {
			const verbText = actionVerb(name, ctx);
			const verb = theme.bold(theme.fg("text", verbText));
			if (name === "bash") {
				const title = ctx?.isError ? "Command failed"
					: ctx?.isPartial && !ctx?.executionStarted ? "Command" : `${verbText} command`;
				const purpose = commandPurpose(purposeArgument(a));
				const header = theme.fg(ctx?.isError ? "error" : "muted", `${BULLET} ${title}`)
					+ (purpose ? theme.fg("dim", " · ") + theme.fg("text", purpose) : "");
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
			}, summarize(name, result, ctx?.args) || "done", { volatile: !!opts?.isPartial, revision: groupedRevision });
		}
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
					const purposeMetadata: Partial<ToolDefinition<any>> = {
						parameters: { ...definition.parameters, properties: { purpose: purposeParameter, ...definition.parameters.properties } },
						...(name === "bash" ? { promptGuidelines: [...(definition.promptGuidelines ?? []), COMMAND_PURPOSE_GUIDELINE] } : {}),
						execute: (id, args, signal, update, context) => {
							const toolArgs = withoutPurpose(args as Record<string, unknown>);
							if (name === "write") return executeWriteWithDiff(cwd, id, toolArgs, signal, update, context);
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
			restoreGroups(ctx);
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
		pi.on("session_tree", (_event, ctx) => restoreGroups(ctx));
		pi.on("session_compact", (_event, ctx) => restoreGroups(ctx));
		pi.on("session_shutdown", () => {
			unsubscribeStyle?.();
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
