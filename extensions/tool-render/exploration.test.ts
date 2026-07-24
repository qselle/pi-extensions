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

	test("merged status is error when any coalesced read errored", () => {
		noteStart("a", "read", { path: "z.ts", offset: 1, limit: 10 });
		noteStart("b", "read", { path: "z.ts", offset: 11, limit: 10 });
		noteEnd("a", true);
		expect(groupState("a")!.rows[0]!.status).toBe("error");
	});
});
