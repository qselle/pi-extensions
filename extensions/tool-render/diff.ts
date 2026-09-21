export type DiffKind = "add" | "del" | "ctx";

export interface DiffRow {
	kind: DiffKind;
	/** Line number in its own side (new file for add/ctx, old file for del). */
	num: number;
	content: string;
}

export function parseUnifiedPatch(patch: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (const line of (patch ?? "").split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			oldNo = Number.parseInt(hunk[1]!, 10);
			newNo = Number.parseInt(hunk[2]!, 10);
			continue;
		}
		if (line.startsWith("\\")) continue; // "\ No newline at end of file"
		if (line.startsWith("+")) {
			rows.push({ kind: "add", num: newNo, content: line.slice(1) });
			newNo += 1;
		} else if (line.startsWith("-")) {
			rows.push({ kind: "del", num: oldNo, content: line.slice(1) });
			oldNo += 1;
		} else if (line.startsWith(" ")) {
			rows.push({ kind: "ctx", num: newNo, content: line.slice(1) });
			oldNo += 1;
			newNo += 1;
		}
	}
	return rows;
}

export function contentToAddRows(content: string): DiffRow[] {
	if (!content) return [];
	return content
		.replace(/\n$/, "")
		.split("\n")
		.map((line, i) => ({ kind: "add" as const, num: i + 1, content: line }));
}

export function gutterWidth(rows: DiffRow[], min = 2): number {
	return rows.reduce((w, r) => Math.max(w, String(r.num).length), min);
}

/** Reapply the background after highlighter resets, then pad it to the row width. */
export function washLine(bgAnsi: string, precolored: string, visibleLen: number, width: number): string {
	const body = precolored.replace(/\x1b\[(?:0|39|49)m/g, (m) => m + bgAnsi);
	const pad = visibleLen < width ? " ".repeat(width - visibleLen) : "";
	return `${bgAnsi}${body}${pad}\x1b[0m`;
}

export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const r of rows) {
		if (r.kind === "add") added++;
		else if (r.kind === "del") removed++;
	}
	return { added, removed };
}
