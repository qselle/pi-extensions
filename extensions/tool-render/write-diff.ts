import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createWriteToolDefinition, generateUnifiedPatch, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Larger overwrites skip diffing; their cards show the new content as added. */
export const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_DIFF_LINES = 5_000;
/** Saved patches stay bounded; counts still describe the whole change. */
export const MAX_PATCH_ROWS = 400;

/** Saved in write results that replaced an existing text file. */
export interface WriteDiffDetails {
	patch: string;
	added: number;
	removed: number;
	/** Patch rows beyond `MAX_PATCH_ROWS` that were not saved. */
	omittedRows?: number;
}

const lineCount = (text: string) => (text ? text.split("\n").length : 0);
const diffable = (text: string) => text.length <= MAX_DIFF_BYTES && lineCount(text) <= MAX_DIFF_LINES;

/** `undefined`: no previous file. `null`: present but not a diffable text file. */
async function previousText(path: string): Promise<string | null | undefined> {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_DIFF_BYTES) return null;
		const bytes = await readFile(path);
		return bytes.includes(0) ? null : bytes.toString("utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : null;
	}
}

export function writeDiffDetails(path: string, previous: string | null | undefined, next: string): WriteDiffDetails | undefined {
	if (typeof previous !== "string" || !diffable(previous) || !diffable(next)) return undefined;
	const lines = generateUnifiedPatch(path, previous, next).split("\n");
	let added = 0;
	let removed = 0;
	let rows = 0;
	let end = lines.length;
	for (const [index, line] of lines.entries()) {
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("\\")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
		else if (!line.startsWith(" ")) continue;
		if (++rows === MAX_PATCH_ROWS) end = index + 1;
	}
	const omittedRows = Math.max(0, rows - MAX_PATCH_ROWS);
	return { patch: lines.slice(0, end).join("\n"), added, removed, ...(omittedRows ? { omittedRows } : {}) };
}

/**
 * Run Pi's write tool with operations that read the previous content inside its
 * per-file mutation queue, then attach a bounded patch for the card.
 */
type Execute = ToolDefinition<any>["execute"];

export async function executeWriteWithDiff(
	cwd: string,
	id: string,
	args: Record<string, unknown>,
	signal: Parameters<Execute>[2],
	update: Parameters<Execute>[3],
	context: Parameters<Execute>[4],
): ReturnType<Execute> {
	let previous: string | null | undefined;
	const tool = createWriteToolDefinition(cwd, {
		operations: {
			mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => {}),
			writeFile: async (path, content) => {
				previous = await previousText(path);
				await writeFile(path, content, "utf-8");
			},
		},
	});
	const result = await tool.execute(id, args as { path: string; content: string }, signal, update, context);
	const details = writeDiffDetails(String(args?.path ?? ""), previous, String(args?.content ?? ""));
	return details ? { ...result, details } : result;
}
