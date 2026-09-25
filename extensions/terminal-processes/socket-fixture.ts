import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WireRequest { id: string; method: string; params: any }
export async function fakeHerdr() {
  const root = await mkdtemp(join(tmpdir(), "pi-term-"));
  const path = join(root, "herdr.sock"), sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, "synthetic saved session\n");
  const panes = new Map<string, any>([["w1:p1", { pane_id: "w1:p1", terminal_id: "terminal-origin", tab_id: "w1:t1" }]]);
  const state = { width: 160, height: 40, recent: "ready\n", visible: "visible\n", truncated: false };
  const requests: WireRequest[] = [], sockets = new Set<Socket>();
  let intercept: ((request: WireRequest, socket: Socket) => Promise<boolean> | boolean) | undefined;
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request: WireRequest = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      if (await intercept?.(request, socket)) return;
      const { method, params } = request;
      let result: any;
      if (method === "pane.get") result = { type: "pane_info", pane: panes.get(params.pane_id) };
      if (method === "pane.layout") result = { type: "pane_layout", layout: { panes: [{ pane_id: params.pane_id, rect: { width: state.width, height: state.height } }] } };
      if (method === "pane.split") {
        const n = panes.size + 1;
        const pane = { pane_id: `w1:p${n}`, terminal_id: `terminal-${n}`, tab_id: "w1:t1" };
        panes.set(pane.pane_id, pane); result = { type: "pane_info", pane };
      }
      if (method === "pane.rename") result = { type: "pane_info", pane: { ...panes.get(params.pane_id), label: params.label } };
      if (method === "pane.send_input") result = { type: "ok" };
      if (method === "pane.read") result = { type: "pane_read", read: { pane_id: params.pane_id, text: params.source === "visible" ? state.visible : state.recent, truncated: state.truncated } };
      if (method === "pane.process_info") result = { type: "pane_process_info", process_info: { pane_id: params.pane_id, foreground_processes: [{ name: "node", pid: 123, cmdline: "node --token=SECRET", argv: ["SECRET"] }] } };
      socket.end(JSON.stringify(result ? { id: request.id, result } : { id: request.id, error: { message: "unsupported" } }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { root, path, sessionFile, panes, requests, state,
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "w1:p1" },
    intercept: (handler?: typeof intercept) => { intercept = handler; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); },
  };
}
