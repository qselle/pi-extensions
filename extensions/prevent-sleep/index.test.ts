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

	test.each(["linux", "win32"] as const)("%s is a no-op (no command, handlers, or wake lock)", (platform) => {
		const h = harness(platform);
		expect(h.commands["prevent-sleep"]).toBeUndefined();
		expect(Object.keys(h.handlers)).toEqual([]);
		h.fire("agent_start");
		expect(h.spawned).toHaveLength(0);
	});
});

test("reports helper startup failure and unexpected exit without claiming an active lock", async () => {
  const { EventEmitter } = await import("node:events");
  const handlers = new Map<string, Function>();
  let command: any;
  const children: any[] = [];
  const messages: string[] = [];
  const pi = { on: (event: string, handler: Function) => handlers.set(event, handler), registerCommand: (_name: string, value: any) => { command = value; } };
  preventSleep(pi as any, { platform: "darwin", spawn: (() => {
    const child = new EventEmitter() as any;
    child.kill = () => true;
    children.push(child);
    return child;
  }) as any });
  const status = async () => { await command.handler("", { ui: { notify: (message: string) => messages.push(message) } }); return messages.at(-1)!; };
  handlers.get("agent_start")!();
  expect(await status()).toContain("starting");
  children[0].emit("error", new Error("missing binary"));
  expect(await status()).toContain("unavailable");
  expect(await status()).not.toContain("idle");
  handlers.get("agent_start")!();
  children[1].emit("spawn");
  expect(await status()).toContain("running");
  children[1].emit("exit", 1, null);
  expect(await status()).toContain("code 1");
  handlers.get("session_shutdown")!();
  handlers.get("agent_start")!();
  expect(children).toHaveLength(2);
});

test("session reset releases an old helper and ignores its late exit", async () => {
  const { EventEmitter } = await import("node:events");
  const handlers = new Map<string, Function>();
  const children: any[] = [];
  let command: any;
  let killed = 0;
  preventSleep({ on: (event: string, handler: Function) => handlers.set(event, handler), registerCommand: (_name: string, value: any) => { command = value; } } as any, {
    platform: "darwin", spawn: (() => { const child = new EventEmitter() as any; child.kill = () => { killed++; return true; }; children.push(child); return child; }) as any,
  });
  handlers.get("agent_start")!();
  handlers.get("session_start")!();
  expect(killed).toBe(1);
  handlers.get("agent_start")!();
  children[1].emit("spawn");
  children[0].emit("exit", 1, null);
  let message = "";
  await command.handler("", { ui: { notify: (text: string) => { message = text; } } });
  expect(message).toContain("running");
  expect(message).not.toContain("unavailable");
  handlers.get("agent_settled")!();
  expect(killed).toBe(2);
});
