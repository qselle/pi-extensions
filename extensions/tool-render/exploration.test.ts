import { beforeEach, describe, expect, test } from "bun:test";
import {
	activityFor,
	bindLeaderRerender,
	closeGroup,
	groupState,
	isLeader,
	noteEnd,
	noteStart,
	resetExploration,
} from "./exploration.ts";

beforeEach(() => resetExploration());

describe("activityFor", () => {
	test("maps exploration tools to verb + detail", () => {
		expect(activityFor("read", { path: "/x/a.ts" })?.verb).toBe("Read");
		expect(activityFor("ls", {})).toEqual({ verb: "Listed", detail: "." });
		expect(activityFor("grep", { pattern: "foo" })).toEqual({ verb: "Searched", detail: '"foo"' });
		expect(activityFor("find", { pattern: "*.ts" })).toEqual({ verb: "Found", detail: '"*.ts"' });
		expect(activityFor("bash", { command: "x" })).toBeUndefined();
	});
});

describe("grouping", () => {
	test("consecutive calls form one group; the first is the leader", () => {
		noteStart("a", "read", { path: "a.ts" });
		noteStart("b", "read", { path: "b.ts" });
		noteStart("c", "grep", { pattern: "x" });
		expect(isLeader("a")).toBe(true);
		expect(isLeader("b")).toBe(false);
		expect(groupState("a")!.activities.map((x) => x.verb)).toEqual(["Read", "Read", "Searched"]);
		expect(groupState("a")!.active).toBe(true);
	});

	test("a closed run (e.g. a bash) starts a fresh group for later calls", () => {
		noteStart("a", "read", { path: "a.ts" });
		closeGroup();
		noteStart("b", "read", { path: "b.ts" });
		expect(isLeader("a")).toBe(true);
		expect(isLeader("b")).toBe(true);
		expect(groupState("a")!.activities.length).toBe(1);
		expect(groupState("b")!.activities.length).toBe(1);
	});

	test("goes inactive (Explored) once closed and finished; tracks status", () => {
		noteStart("a", "read", { path: "a.ts" });
		noteEnd("a", false);
		expect(groupState("a")!.active).toBe(true); // still accepting
		closeGroup();
		expect(groupState("a")!.active).toBe(false);
		expect(groupState("a")!.activities[0]!.status).toBe("done");

		noteStart("e", "read", { path: "e.ts" });
		noteEnd("e", true);
		expect(groupState("e")!.activities[0]!.status).toBe("error");
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
