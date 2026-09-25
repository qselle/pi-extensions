import { beforeEach, describe, expect, test } from "bun:test";
import {
	activityFor,
	bindLeaderRerender,
	closeGroup,
	groupState,
	isLeader,
	noteEnd,
	noteStart,
	readRange,
	resetExploration,
	previewRows,
	restoreExploration,
} from "./exploration.ts";

beforeEach(() => resetExploration());

describe("readRange", () => {
	test("offset+limit, offset-only, limit-only, none", () => {
		expect(readRange({ offset: 10, limit: 31 })).toBe("10-40");
		expect(readRange({ offset: 5 })).toBe("5+");
		expect(readRange({ limit: 20 })).toBe("1-20");
		expect(readRange({})).toBeUndefined();
	});
});

describe("activityFor", () => {
	test("maps tools to verb/detail; reads carry path + range", () => {
		expect(activityFor("read", { path: "/x/a.ts" })).toMatchObject({ verb: "Read", detail: "/x/a.ts", path: "/x/a.ts" });
		expect(activityFor("read", { path: "a.ts", offset: 10, limit: 31 })!.range).toBe("10-40");
		expect(activityFor("ls", {})).toMatchObject({ verb: "Listed", detail: "." });
		expect(activityFor("grep", { pattern: "foo" })).toMatchObject({ verb: "Searched", detail: '"foo"' });
		expect(activityFor("find", { pattern: "*.ts" })).toMatchObject({ verb: "Found", detail: '"*.ts"' });
		expect(activityFor("bash", { command: "x" })).toBeUndefined();
	});
	test("search activity includes the requested directory and file glob", () => {
		expect(activityFor("grep", { pattern: "token", path: "src", glob: "*.ts" })!.detail).toBe('"token" in src (*.ts)');
		expect(activityFor("find", { pattern: "*.test.ts", path: "tests" })!.detail).toBe('"*.test.ts" in tests');
	});
});

describe("grouping", () => {
	test("consecutive calls form one group; the first is the leader", () => {
		noteStart("a", "read", { path: "a.ts" });
		noteStart("b", "grep", { pattern: "x" });
		expect(isLeader("a")).toBe(true);
		expect(isLeader("b")).toBe(false);
		expect(groupState("a")!.rows.map((r) => r.verb)).toEqual(["Read", "Searched"]);
		expect(groupState("a")!.active).toBe(true);
	});

	test("a closed run starts a fresh group for later calls", () => {
		noteStart("a", "read", { path: "a.ts" });
		closeGroup();
		noteStart("b", "read", { path: "b.ts" });
		expect(isLeader("a")).toBe(true);
		expect(isLeader("b")).toBe(true);
	});

	test("goes inactive once closed and finished; tracks status", () => {
		noteStart("a", "read", { path: "a.ts" });
		noteEnd("a", false, "42 lines");
		expect(groupState("a")!.active).toBe(true); // still accepting
		closeGroup();
		expect(groupState("a")!.active).toBe(false);
		expect(groupState("a")!.rows[0]!.status).toBe("done");
	});

	test("the leader's rerender fires when a follower joins", () => {
		let calls = 0;
		noteStart("a", "read", { path: "a.ts" });
		bindLeaderRerender("a", () => {
			calls++;
		});
		noteStart("b", "read", { path: "b.ts" });
		expect(calls).toBe(1);
	});

	test("unknown calls have no group", () => {
		expect(groupState("nope")).toBeUndefined();
		expect(isLeader("nope")).toBe(false);
	});
});

describe("display rows", () => {
	test("read and directory rows retain raw paths for clickable targets", () => {
		noteStart("a", "read", { path: "src/a.ts" });
		noteStart("b", "ls", { path: "src" });
		expect(groupState("a")!.rows.map((row) => row.filePath)).toEqual(["src/a.ts", "src"]);
	});
	test("whole-file read shows a line count; grep shows a result count", () => {
		noteStart("a", "read", { path: "a.ts" });
		noteEnd("a", false, "42 lines");
		noteStart("b", "grep", { pattern: "verify(" });
		noteEnd("b", false, "7 matches");
		const rows = groupState("a")!.rows;
		expect(rows[0]).toMatchObject({ verb: "Read", detail: "a.ts", suffix: "42 lines" });
		expect(rows[1]).toMatchObject({ verb: "Searched", detail: '"verify("', suffix: "7 matches" });
	});

	test("a chunked read shows its range instead of a count", () => {
		noteStart("a", "read", { path: "a.ts", offset: 10, limit: 31 });
		noteEnd("a", false, "31 lines");
		expect(groupState("a")!.rows[0]).toMatchObject({ detail: "a.ts", suffix: "lines 10-40" });
	});

	test("consecutive reads of the same file coalesce and merge ranges", () => {
		noteStart("a", "read", { path: "big.ts", offset: 1, limit: 40 });
		noteStart("b", "read", { path: "big.ts", offset: 101, limit: 100 });
		noteStart("c", "read", { path: "other.ts" });
		noteEnd("c", false, "8 lines");
		const rows = groupState("a")!.rows;
		expect(rows.length).toBe(2);
		expect(rows[0]).toMatchObject({ detail: "big.ts", suffix: "lines 1-40, 101-200" });
		expect(rows[1]).toMatchObject({ detail: "other.ts", suffix: "8 lines" });
	});

	test("a non-read between reads splits the coalescing runs", () => {
		noteStart("a", "read", { path: "x.ts" });
		noteStart("b", "grep", { pattern: "q" });
		noteStart("c", "read", { path: "x.ts" });
		expect(groupState("a")!.rows.map((r) => `${r.verb}:${r.detail}`)).toEqual([
			"Read:x.ts",
			'Searched:"q"',
			"Read:x.ts",
		]);
	});

	test("read coalescing preserves distinct intents and merges matching captions", () => {
		noteStart("a", "read", { path: "same.ts", offset: 1, limit: 10, purpose: "Inspect token validation" });
		noteStart("b", "read", { path: "same.ts", offset: 20, limit: 10, purpose: "Inspect token validation" });
		noteStart("c", "read", { path: "same.ts", offset: 40, limit: 10, purpose: "Review error handling" });
		const rows = groupState("a")!.rows;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ purpose: "Inspect token validation", suffix: "lines 1-10, 20-29" });
		expect(rows[1]).toMatchObject({ purpose: "Review error handling", suffix: "lines 40-49" });
	});

	test("merged status is error when any coalesced read errored", () => {
		noteStart("a", "read", { path: "z.ts", offset: 1, limit: 10 });
		noteStart("b", "read", { path: "z.ts", offset: 11, limit: 10 });
		noteEnd("a", true);
		expect(groupState("a")!.rows[0]!.status).toBe("error");
	});
});

test("a coalesced failed read preserves the failure instead of a successful range", () => {
  noteStart("first", "read", { path: "file", offset: 1, limit: 10 });
  noteEnd("first", false, "10 lines");
  noteStart("second", "read", { path: "file", offset: 20, limit: 10 });
  noteEnd("second", true, "failed: Permission denied");
  expect(groupState("first")!.rows[0]).toMatchObject({ status: "error", suffix: "failed: Permission denied" });
});

describe("collapsed viewport", () => {
	const rows = Array.from({ length: 12 }, (_, index) => ({ verb: "Read", detail: `file-${index}.ts`, status: "done" as "done" | "pending" | "error" }));
	test("shows recent work while reserving space for failures and pending calls", () => {
		const input = rows.map((row) => ({ ...row }));
		input[0]!.status = "error";
		input[3]!.status = "pending";
		const preview = previewRows(input);
		expect(preview.rows.map((row) => row.detail)).toEqual(["file-0.ts", "file-3.ts", "file-9.ts", "file-10.ts", "file-11.ts"]);
		expect(preview).toMatchObject({ omitted: 7, failed: 0, pending: 0 });
	});
	test("counts omitted failures honestly when they exceed the viewport", () => {
		const preview = previewRows(rows.map((row) => ({ ...row, status: "error" as const })));
		expect(preview.rows).toHaveLength(5);
		expect(preview).toMatchObject({ omitted: 7, failed: 7 });
	});
});

describe("saved exploration", () => {
	const call = (id: string, name = "read", args: any = { path: `${id}.ts` }) => ({ type: "toolCall", id, name, arguments: args });
	const assistant = (calls: any[], stopReason = "toolUse") => ({ type: "message", message: { role: "assistant", content: calls, stopReason } });
	const result = (id: string, options: any = {}) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "read", content: "a\n\nb", isError: false, ...options } });
	test("reconstructs old groups with read ranges, outcomes and assistant/tool boundaries", () => {
		restoreExploration([
			assistant([call("a", "read", { path: "large.ts", offset: 20, limit: 10 }), call("b", "grep", { pattern: "cache", path: "src" }), call("bash", "bash"), call("c")]),
			result("a"), result("b", { toolName: "grep", content: "No matches found" }), result("bash", { toolName: "bash" }), result("c"),
			assistant([call("d"), call("e")]), result("d"), result("e", { isError: true, content: "Permission denied\nRead another path" }),
		]);
		expect(groupState("a")).toMatchObject({ active: false, rows: [{ suffix: "lines 20-29" }, { suffix: "0 matches" }] });
		expect(isLeader("b")).toBe(false);
		expect(isLeader("c")).toBe(true);
		expect(isLeader("d")).toBe(true);
		expect(groupState("e")?.rows[1]).toMatchObject({ status: "error", suffix: "failed: Permission denied" });
		noteStart("fresh", "read", { path: "fresh.ts" });
		expect(isLeader("fresh")).toBe(true);
	});
	test("missing, duplicate, mismatched and aborted calls stay visible as standalone cards", () => {
		restoreExploration([
			assistant([call("missing"), call("a"), call("duplicate"), call("mismatch"), call("b")]),
			result("a"), result("duplicate"), result("duplicate"), result("mismatch", { toolName: "ls" }), result("b"),
			assistant([call("aborted")], "aborted"), result("aborted"),
			assistant([call("same"), call("same")]), result("same"),
		]);
		for (const id of ["missing", "duplicate", "mismatch", "aborted", "same"]) expect(groupState(id)).toBeUndefined();
		expect(isLeader("a")).toBe(true);
		expect(isLeader("b")).toBe(true);
	});
	test("changing branches discards stale and dangling group membership", () => {
		restoreExploration([assistant([call("a"), call("b")]), result("a"), result("b")]);
		restoreExploration([result("a"), assistant([call("new")]), result("new")]);
		expect(groupState("a")).toBeUndefined();
		expect(groupState("b")).toBeUndefined();
		expect(isLeader("new")).toBe(true);
	});
});
