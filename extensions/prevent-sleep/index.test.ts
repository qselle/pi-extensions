import { describe, expect, test } from "bun:test";
import preventSleep from "./index.ts";

/** A fake pi + injected spawn that records spawned "inhibitor" children. */
function harness(platform: NodeJS.Platform = "darwin") {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, any> = {};
	const spawned: Array<{ cmd: string; args: string[]; killed: boolean }> = [];
	const pi: any = {
		on: (e: string, h: Function) => {
			(handlers[e] ??= []).push(h);
		},
		registerCommand: (name: string, opts: any) => {
			commands[name] = opts;
		},
	};
	const fakeSpawn: any = (cmd: string, args: string[]) => {
		const child: any = { cmd, args, killed: false, once: () => child, kill: () => (child.killed = true) };
		spawned.push(child);
		return child;
	};
	preventSleep(pi, { platform, pid: 4242, spawn: fakeSpawn });
	const fire = (e: string, ev?: any) => (handlers[e] || []).forEach((h) => h(ev ?? {}, {}));
	const run = (arg: string) => commands["prevent-sleep"]?.handler(arg, { ui: { notify() {} } });
	return { handlers, commands, spawned, fire, run };
}

describe("prevent-sleep", () => {
	test("holds a wake lock while the agent works, releases when it settles", () => {
		const h = harness("darwin");
		expect(h.spawned.length).toBe(0);
		h.fire("agent_start");
		expect(h.spawned).toHaveLength(1);
		expect(h.spawned[0]!.cmd).toBe("/usr/bin/caffeinate");
		expect(h.spawned[0]!.args).toEqual(["-i", "-w", "4242"]);
		expect(h.spawned[0]!.killed).toBe(false);
		h.fire("agent_settled");
		expect(h.spawned[0]!.killed).toBe(true);
	});

	test("does not stack a second lock if agent_start repeats", () => {
		const h = harness("darwin");
		h.fire("agent_start");
		h.fire("agent_start");
		expect(h.spawned).toHaveLength(1);
	});

	test("/prevent-sleep off releases an active lock; on re-acquires while working", () => {
		const h = harness("darwin");
		h.fire("agent_start");
		h.run("off");
		expect(h.spawned[0]!.killed).toBe(true);
		h.run("on");
		expect(h.spawned).toHaveLength(2);
		expect(h.spawned[1]!.killed).toBe(false);
	});

	test("session_shutdown releases the lock", () => {
		const h = harness("darwin");
		h.fire("agent_start");
		h.fire("session_shutdown");
		expect(h.spawned[0]!.killed).toBe(true);
	});

	test("unsupported platform is a no-op (no command, no wake lock)", () => {
		const h = harness("win32");
		expect(h.commands["prevent-sleep"]).toBeUndefined();
		h.fire("agent_start");
		expect(h.spawned).toHaveLength(0);
	});
});
