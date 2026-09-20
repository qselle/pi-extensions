import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("separate Pi processes share one bot poll and both receive their replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-inbox-process-"));
  let polls = 0;
  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.json() as any;
    if (body.offset === -1) return Response.json({ ok: true, result: [] });
    polls += 1; active += 1; maximum = Math.max(maximum, active);
    await gate; active -= 1;
    return Response.json({ ok: true, result: [1, 2].map((id) => ({ update_id: id, message: {
      message_id: 10 + id, text: "yes", chat: { id: 12345 }, reply_to_message: { message_id: id },
    } })) });
  } });
  const children = [1, 2].map((id) => Bun.spawn([process.execPath, join(import.meta.dir, "inbox.integration-fixture.ts"), root, server.url.toString(), String(id)], { stdout: "pipe", stderr: "pipe" }));
  const outputs = ["", ""];
  const reading = children.map(async (child, index) => {
    const reader = child.stdout.getReader(); const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      outputs[index] += decoder.decode(chunk.value, { stream: true });
      if (outputs.every((output) => output.includes("ready"))) release();
    }
  });
  try {
    const codes = await Promise.all(children.map((child) => child.exited));
    await Promise.all(reading);
    const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect(codes, errors.join("\n")).toEqual([0, 0]);
    expect(outputs[0]).toContain("received 1");
    expect(outputs[1]).toContain("received 2");
    expect(maximum).toBe(1);
    expect(polls).toBe(1);
  } finally {
    release(); for (const child of children) child.kill(); server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
