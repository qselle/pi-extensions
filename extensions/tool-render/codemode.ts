/**
 * Restyles Pi's built-in `codemode` tool as one card: a status headline, the
 * script in the command panel, one row per nested tool call, and the output.
 *
 *   • Ran script to collect repo stats · 3 calls · ✓ in 2s
 *     │ const rows = await Promise.all(…)
 *     ├ bash count commits $ git log --oneline ×2 · ✓
 *     ├ read README.md · ✓
 *     └ | Repo | Commits |
 *
 * Only the renderers change; the definition comes from Pi's own
 * `createCodemodeExtension()`, so execution, settings and default activation
 * stay Pi's. Registration waits for `session_start`: registering the same tool
 * during load replaces the built-in extension with a startup warning, while a
 * later registration shadows its definition.
 */
import * as coding from "@earendil-works/pi-coding-agent";
import type { CodemodeToolDetails, ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { PlainOutput } from "../../lib/output.ts";
import { commandPurpose } from "../../lib/tool-purpose.ts";
import { expansionHint } from "../../lib/tool-ui.ts";
import { formatElapsed } from "./bash-status.ts";
import { BULLET, bashBody, bashStatus, highlightSource, wrapRows } from "./card.ts";
import { commandPanel } from "./command-panel.ts";
import { fit, Lines } from "./lines.ts";

export type CodemodeCall = CodemodeToolDetails["calls"][number];

const TOOL_NAME = "codemode";
const SCRIPT_ROWS = 8;
const CALL_ROWS = 6;
const EXPANDED_CALL_ROWS = 200;
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n/;

/** Same wording as the reference extension, so switching keeps the prompt identical. */
export const INTENT_GUIDELINE = "Start each codemode script with a `// <≤8-word present-tense intent>` comment line, after any `// @options:` line.";

const OPTIONS_LINE = /^\s*\/\/\s*@options:.*(?:\n|$)/;
const INTENT_LINE = /^\s*\/\/[ \t]*([^@\s][^\n]*?)[ \t.]*(?:\n|$)/;

const normalize = (code: string): string => new PlainOutput().push(code).replace(/\t/g, "    ").replace(/\s+$/, "");

/** `Check S3 buckets` follows "to" as `check S3 buckets`; acronyms keep their case. */
const lowerInitial = (text: string): string => text.replace(/^(\p{Lu})(?=\p{Ll}+(?![\p{L}\p{N}]))/u, (letter) => letter.toLocaleLowerCase());

/**
 * Codemode has no purpose argument: some providers sample the script as raw
 * JavaScript. A prompt guideline asks for a leading `// intent` comment after the
 * optional `// @options:` pragma; collapsed cards show it in the headline instead.
 */
export function splitScript(code: string): { intent: string; body: string } {
	const body = normalize(code).replace(OPTIONS_LINE, "").replace(/^\s*\n/, "");
	const match = body.match(INTENT_LINE);
	if (!match) return { intent: "", body };
	return { intent: lowerInitial(commandPurpose(match[1])), body: body.slice(match[0].length) };
}

/** Argument keys that show what a call acts on, in preference order. */
const PRIMARY_KEYS = ["command", "path", "pattern", "query", "url", "action"];
/** Shell-style `NAME=value` assignments whose name suggests a credential. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*)=(?:'[^']*'?|"[^"]*"?|\S+)/gi;

export const redactSecrets = (text: string): string => text.replace(SECRET_ASSIGNMENT, "$1=***");

const plain = (text: string): string => new PlainOutput().push(text).replace(/\p{Bidi_Control}/gu, "").replace(/\s+/g, " ").trim();

/** Decode a JSON string body that Pi's 200-character preview may cut mid-escape. */
function decodeJsonString(body: string): string {
	const safe = body.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
	try {
		return JSON.parse(`"${safe}"`);
	} catch {
		return safe;
	}
}

/** A string field of argument JSON that may be truncated with a trailing `...`. */
function stringField(args: string, key: string): { value: string; complete: boolean } | undefined {
	const match = args.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)("?)`));
	if (!match) return undefined;
	const complete = match[2] === '"';
	return { value: decodeJsonString(complete ? match[1]! : match[1]!.replace(/\.\.\.$/, "")), complete };
}

/**
 * A call's purpose and the main argument it acts on. A long argument written
 * before the purpose can push it out of the preview; the detail still shows
 * what ran, with credential-like assignments masked.
 */
function callParts(call: CodemodeCall): { reason: string; detail: string } {
	const args = typeof call.args === "string" ? call.args : "";
	const written = [stringField(args, "purpose"), stringField(args, "reasoning")]
		.find((field) => field?.complete && commandPurpose(field.value));
	const reason = written ? commandPurpose(written.value) : "";
	for (const key of PRIMARY_KEYS) {
		const field = stringField(args, key);
		if (!field) continue;
		return { reason, detail: `${key === "command" ? "$ " : ""}${plain(redactSecrets(field.value))}${field.complete ? "" : "…"}` };
	}
	// Unknown shapes keep their JSON unless the purpose already says enough.
	return { reason, detail: reason || args === "{}" ? "" : plain(redactSecrets(args)) };
}

interface CallGroup {
	name: string;
	reason: string;
	/** The first call's detail; `mixed` marks groups whose details differ. */
	detail: string;
	mixed: boolean;
	calls: CodemodeCall[];
}

/** Collapsed cards join consecutive calls of one tool and purpose, such as a fan-out. */
export function groupCalls(calls: readonly CodemodeCall[], expanded: boolean): CallGroup[] {
	const groups: CallGroup[] = [];
	for (const call of calls) {
		const { reason, detail } = callParts(call);
		const last = groups.at(-1);
		// Without a purpose, the detail is the only thing that identifies the call.
		if (!expanded && last && last.name === call.name && last.reason === reason && (reason || last.detail === detail)) {
			if (last.detail !== detail) last.mixed = true;
			last.calls.push(call);
		} else {
			groups.push({ name: String(call.name), reason, detail, mixed: false, calls: [call] });
		}
	}
	return groups;
}

const formatCost = (cost: number): string => `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;

function groupStatus(group: CallGroup, theme: Theme): string {
	const count = (status: CodemodeCall["status"]) => group.calls.filter((call) => call.status === status).length;
	const [running, failed, cancelled] = [count("running"), count("error"), count("cancelled")];
	const marks: string[] = [];
	if (running) marks.push(theme.fg("accent", "…"));
	if (failed) marks.push(theme.fg("error", group.calls.length > 1 ? `✗ ${failed}` : "✗"));
	if (cancelled) marks.push(theme.fg("dim", "⊘"));
	if (!marks.length) marks.push(theme.fg("success", "✓"));
	// A single call shows its own duration and cost; a parallel group has none.
	const single = group.calls.length === 1 ? group.calls[0] : undefined;
	const elapsed = single?.durationMs !== undefined ? formatElapsed(single.durationMs) : "";
	const cost = single?.cost ? formatCost(single.cost) : "";
	return theme.fg("dim", " · ") + marks.join(" ") + (elapsed ? theme.fg("dim", ` in ${elapsed}`) : "")
		+ (cost ? theme.fg("dim", ` ${cost}`) : "");
}

function callRows(calls: readonly CodemodeCall[], theme: Theme, width: number, expanded: boolean, closes: boolean): string[] {
	let groups = groupCalls(calls, expanded);
	const limit = expanded ? EXPANDED_CALL_ROWS : CALL_ROWS;
	const inner = Math.max(1, width - 4);
	const rows: string[] = [];
	if (groups.length > limit) {
		const hidden = groups.slice(0, groups.length - (limit - 1));
		groups = groups.slice(-(limit - 1));
		const count = hidden.reduce((sum, group) => sum + group.calls.length, 0);
		const failed = hidden.reduce((sum, group) => sum + group.calls.filter((call) => call.status === "error").length, 0);
		const notice = `… +${count} earlier ${count === 1 ? "call" : "calls"}${failed ? ` (${failed} failed)` : ""} · ${expanded ? "preview limit" : expansionHint()}`;
		rows.push(theme.fg("dim", "  ├ ") + theme.fg(failed ? "error" : "dim", fit(notice, inner)));
	}
	groups.forEach((group, index) => {
		const connector = closes && index === groups.length - 1 ? "└" : "├";
		const others = group.calls.length - 1;
		const state = group.calls.some((call) => call.status === "running") ? "accent"
			: group.calls.some((call) => call.status === "error") ? "error" : "muted";
		const label = theme.fg(state, group.name)
			+ (group.reason ? ` ${theme.fg("text", group.reason)}` : "")
			+ (group.detail ? ` ${theme.fg("dim", group.detail)}` : "")
			+ (others ? ` ${theme.fg("dim", group.mixed ? `(+${others})` : `×${group.calls.length}`)}` : "");
		// Clip the label, never the status.
		const status = groupStatus(group, theme);
		rows.push(theme.fg("dim", `  ${connector} `) + fit(label, Math.max(1, inner - visibleWidth(status))) + status);
		if (!expanded) return;
		for (const call of group.calls) {
			if (!call.error) continue;
			const error = new PlainOutput().push(call.error).trim();
			for (const line of error.split("\n")) {
				rows.push(...wrapRows(theme.fg("error", line), inner - 2, true).map((row) => `      ${row}`));
			}
		}
	});
	return rows;
}

/** Script output without Pi's "Script completed / Wall time / Output:" header. */
export function scriptOutput(result: any): { text: string; wallSeconds?: number } {
	const content: any[] = Array.isArray(result?.content) ? result.content : [];
	const texts = content.filter((part) => part?.type === "text").map((part) => String(part.text ?? ""));
	const header = texts[0]?.match(SCRIPT_HEADER);
	if (!header) return { text: texts.join("\n") };
	const rest = [texts[0]!.slice(header[0].length), ...texts.slice(1)].filter(Boolean);
	return { text: rest.join("\n"), wallSeconds: Number(header[1]) };
}

export interface CodemodeView {
	code: string;
	result?: any;
	/** Pi's partial flag: streaming arguments or a running script. */
	partial: boolean;
	started: boolean;
	error: boolean;
	expanded: boolean;
	/** Tool call ID, for the live elapsed time of a running script. */
	id?: string;
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/** The whole card. Settled cards depend only on the view and width. */
export function renderCodemodeCard(
	view: CodemodeView,
	theme: Theme,
	width: number,
	highlight = (source: string) => highlightSource(source, "javascript", theme),
): string[] {
	const { intent, body } = splitScript(view.code);
	const calls: CodemodeCall[] = Array.isArray(view.result?.details?.calls) ? view.result.details.calls : [];
	const running = view.started && view.partial;
	const settled = !view.partial;
	const failed = settled && view.error;
	const output = settled ? scriptOutput(view.result) : { text: "" };

	const title = failed ? "Script failed" : running ? "Running script" : view.partial ? "Script" : "Ran script";
	const left = theme.fg(failed ? "error" : "muted", `${BULLET} ${title}`)
		+ (intent ? theme.fg("dim", " to ") + theme.fg("text", intent) : "");
	const count = calls.length ? theme.fg("dim", ` · ${plural(calls.length, "call")}`) : "";
	const wall = output.wallSeconds !== undefined && Number.isFinite(output.wallSeconds) ? formatElapsed(output.wallSeconds * 1000) : undefined;
	const status = bashStatus(theme, settled ? { state: failed ? "failed" : "ok", elapsed: wall } : undefined, running, view.id);
	const tail = count + status;
	const lines = [fit(left, Math.max(1, width - visibleWidth(tail))) + tail];

	const source = view.expanded ? normalize(view.code) : body;
	if (source.trim()) lines.push(...commandPanel(highlight(source), width, theme, view.expanded, { limit: SCRIPT_ROWS, noun: "script" }));
	const outputRows = settled
		? bashBody({ content: [{ type: "text", text: new PlainOutput().push(output.text) }] }, { expanded: view.expanded }, theme, width, view.error)
		: [];
	lines.push(...callRows(calls, theme, width, view.expanded, outputRows.length === 0), ...outputRows);
	return lines;
}

const EMPTY: Component = { render: () => [], invalidate() {} };

/**
 * The call slot owns the card; the result slot only records the result. Pi runs
 * both renderers on every update, call first, and renders afterwards, so the
 * card reads the latest result without duplicating the block.
 */
function withRenderers(definition: ToolDefinition<any, any>): ToolDefinition<any, any> {
	return {
		...definition,
		// Registered once per session start, so the system prompt stays stable.
		promptGuidelines: [...(definition.promptGuidelines ?? []), INTENT_GUIDELINE],
		renderShell: "self",
		renderCall: (_args: any, theme: Theme, ctx: any): Component => {
			const state = ctx?.state ?? {};
			const code = typeof ctx?.args?.code === "string" ? ctx.args.code : "";
			// Running cards rebuild every frame; highlight each script source once.
			let cached: { source: string; colored: string } | undefined;
			const highlight = (source: string): string => {
				if (cached?.source !== source) cached = { source, colored: highlightSource(source, "javascript", theme) };
				return cached.colored;
			};
			const view = (): CodemodeView => ({ code, result: state.codemodeResult, partial: ctx?.isPartial !== false,
				started: !!ctx?.executionStarted, error: !!ctx?.isError, expanded: !!ctx?.expanded, id: ctx?.toolCallId });
			return new Lines((width) => renderCodemodeCard(view(), theme, width, highlight), "Ran script", { volatile: ctx?.isPartial !== false });
		},
		renderResult: (result: any, _options: any, _theme: Theme, ctx: any): Component => {
			if (ctx?.state) ctx.state.codemodeResult = result;
			return EMPTY;
		},
	};
}

type CreateCodemode = () => (pi: ExtensionAPI) => void | Promise<void>;

/**
 * Returns a `session_start` step that restyles Pi's built-in codemode once.
 * Disabled codemode and third-party codemode tools are left alone.
 */
export function codemodeRestyler(pi: ExtensionAPI, create: CreateCodemode | undefined = coding.createCodemodeExtension): () => void {
	let registered = false;
	return () => {
		if (registered || typeof create !== "function") return;
		const existing = pi.getAllTools?.().find((tool) => tool.name === TOOL_NAME);
		if (!String(existing?.sourceInfo?.path ?? "").startsWith("builtin:")) return;
		registered = true;
		const proxy = new Proxy(pi, {
			get: (target, key, receiver) => key === "registerTool"
				? (definition: ToolDefinition<any, any>) => target.registerTool(withRenderers(definition))
				: Reflect.get(target, key, receiver),
		});
		try {
			Promise.resolve(create()(proxy)).catch(() => {});
		} catch {
			// Pi's own codemode card remains when the restyled one cannot register.
		}
	};
}
