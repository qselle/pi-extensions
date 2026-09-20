import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { herdrRequest } from "./herdr-client.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function serve(reply: (request: any, socket: Socket) => void) {
  const directory = mkdtempSync(join(tmpdir(), "tab-link-"));
  const path = join(directory, "rpc.sock");
  const sockets = new Set<Socket>();
  const requests: any[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      reply(request, socket);
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.removeListener("error", reject); resolve(); });
  });
  return { path, requests };
}

test("exchanges JSON lines over a real Unix socket and decodes split UTF-8", async () => {
  const result = { type: "tab_info", tab: { tab_id: "w1:t1", label: "🚀 Résumé", pane_count: 1 } };
  const server = await serve((request, socket) => {
    const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`);
    const split = bytes.indexOf(Buffer.from("🚀")) + 1;
    socket.write(bytes.subarray(0, split));
    setImmediate(() => socket.end(bytes.subarray(split)));
  });
  const params = { tab_id: "w1:t1", label: "🚀 Résumé" };
  expect(await herdrRequest(server.path, "tab.rename", params, new AbortController().signal)).toEqual(result);
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]).toMatchObject({ method: "tab.rename", params });
  expect(typeof server.requests[0].id).toBe("string");
});

test.each([
  ["wrong ID", (id: string) => JSON.stringify({ id: `${id}-wrong`, result: {} }), "ID did not match"],
  ["API error", (id: string) => JSON.stringify({ id, error: { message: "private server detail" } }), "rejected"],
  ["missing result", (id: string) => JSON.stringify({ id }), "Unsupported"],
  ["invalid JSON", () => "{broken", "Malformed"],
] as const)("rejects %s without exposing server contents", async (_name, response, message) => {
  const server = await serve((request, socket) => socket.end(`${response(request.id)}\n`));
  await expect(herdrRequest(server.path, "tab.get", { tab_id: "w1:t1" }, new AbortController().signal)).rejects.toThrow(message);
});

test("bounds the entire reply, even when no newline arrives", async () => {
  const server = await serve((_request, socket) => socket.write("x".repeat(65 * 1024)));
  await expect(herdrRequest(server.path, "pane.get", {}, new AbortController().signal)).rejects.toThrow("size limit");
});

test("times out a connected but silent socket", async () => {
  const server = await serve(() => {});
  await expect(herdrRequest(server.path, "pane.get", {}, new AbortController().signal, 30)).rejects.toThrow("in time");
});

test("cancellation closes a pending request and a pre-aborted request never connects", async () => {
  const controller = new AbortController();
  const server = await serve(() => controller.abort());
  await expect(herdrRequest(server.path, "pane.get", {}, controller.signal)).rejects.toThrow("cancelled");
  await expect(herdrRequest(server.path, "pane.get", {}, controller.signal)).rejects.toThrow("cancelled");
  expect(server.requests).toHaveLength(1);
});

test("rejects a truncated reply when the peer disconnects", async () => {
  const server = await serve((_request, socket) => socket.end("{"));
  await expect(herdrRequest(server.path, "pane.get", {}, new AbortController().signal)).rejects.toThrow("closed the connection");
});

test("reports an unavailable socket without leaking its path", async () => {
  await expect(herdrRequest("/tmp/nonexistent-tab-link/socket", "pane.get", {}, new AbortController().signal))
    .rejects.toThrow("Herdr socket is unavailable");
});
