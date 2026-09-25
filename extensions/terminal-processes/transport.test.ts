import { expect, test } from "bun:test";
import { request, socketIdentity } from "./transport.ts";
import { fakeHerdr } from "./socket-fixture.ts";

test("native socket protocol accepts fragmented matching JSON-line replies", async () => {
  const f = await fakeHerdr();
  try {
    f.intercept((r, socket) => {
      const data = JSON.stringify({ id: r.id, result: { type: "ok" } }) + "\n";
      socket.write(data.slice(0, 8)); setTimeout(() => socket.end(data.slice(8)), 2); return true;
    });
    expect(await request(f.path, "pane.send_input", { pane_id: "w1:p2", text: "exact\ntext", keys: ["Enter"] }, new AbortController().signal)).toEqual({ type: "ok" });
    expect(f.requests[0]?.params.text).toBe("exact\ntext");
  } finally { await f.close(); }
});

test("socket rejects wrong IDs, malformed, oversized and secret-echoing errors", async () => {
  const f = await fakeHerdr();
  try {
    for (const reply of ["not json\n", '{"id":"wrong","result":{}}\n', "x".repeat(129)]) {
      f.intercept((_r, socket) => { socket.end(reply); return true; });
      await expect(request(f.path, "pane.get", {}, new AbortController().signal, 1000, 128)).rejects.toThrow();
    }
    f.intercept((r, socket) => { socket.end(JSON.stringify({ id: r.id, error: { message: "SECRET input failed" } }) + "\n"); return true; });
    let error = "";
    try { await request(f.path, "pane.send_input", { text: "SECRET" }, new AbortController().signal); } catch (cause) { error = String(cause); }
    expect(error).toContain("rejected"); expect(error).not.toContain("SECRET");
  } finally { await f.close(); }
});

test("socket timeout and cancellation do not retry requests", async () => {
  const f = await fakeHerdr();
  try {
    f.intercept(() => true);
    await expect(request(f.path, "pane.get", {}, new AbortController().signal, 10)).rejects.toThrow("acknowledge");
    const abort = new AbortController();
    f.intercept(() => { abort.abort(); return true; });
    await expect(request(f.path, "pane.send_input", {}, abort.signal)).rejects.toThrow("cancelled");
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
});

test("socket identity lookup does not expose a missing local socket path", async () => {
  await expect(socketIdentity("/no-such-private-socket/token-value.sock")).rejects.toThrow("Herdr socket is unavailable.");
});
