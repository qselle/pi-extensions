/** Informational native-session and image repaint measurements; no network. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, SessionManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { ImageStore, type ImagePart } from "./storage.ts";
import { syntheticPng } from "./png.fixture.ts";

const root = await mkdtemp(join(tmpdir(), "pi-image-benchmark-"));
process.env.PI_CODING_AGENT_DIR = root;
globalThis.fetch = (() => { throw new Error("No network in image benchmark"); }) as unknown as typeof fetch;
const measure = <T>(run: () => T) => {
  const start = performance.now(), value = run();
  return { ms: +(performance.now() - start).toFixed(2), value };
};
try {
  initTheme("dark", false);
  const store = new ImageStore(join(root, "image-store"));
  const original: ImagePart = { type: "image", data: syntheticPng().toString("base64"), mimeType: "image/png" };
  const start = performance.now(), preview = await store.pack(original), firstPackMs = +(performance.now() - start).toFixed(2);
  const cached = performance.now(); await store.pack(original); const repeatedPackMs = +(performance.now() - cached).toFixed(2);
  const samples = [];
  for (const [name, image] of [["embedded", original], ["preview", preview]] as const) {
    const manager = SessionManager.create(root, join(root, name));
    manager.appendMessage({ role: "user", content: "Inspect these images", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Inspection started" }], api: "openai-responses", provider: "openai", model: "fixture", stopReason: "stop", timestamp: 2,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    for (let index = 0; index < 20; index++) manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: `read-${index}`, content: [image], isError: false, timestamp: index + 3 });
    const path = manager.getSessionFile()!, reopen = measure(() => SessionManager.open(path));
    const results = reopen.value.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    const protocols = [];
    for (const protocol of ["kitty", "iterm2", null] as const) {
      setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
      const ready = new Set<string>();
      const conversionStarted = performance.now();
      const cards = results.map((result) => {
        const card = new ToolExecutionComponent("read", result.toolCallId, { path: "image.png" }, { showImages: true }, undefined,
          { requestRender() { ready.add(result.toolCallId); } } as TUI, root);
        card.updateResult(result); return card;
      });
      if (protocol === "kitty" && image.mimeType !== "image/png") {
        while (ready.size !== cards.length) {
          assert(performance.now() - conversionStarted < 5000, "native Kitty conversion must finish before measuring image paints");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      const conversionWaitMs = +(performance.now() - conversionStarted).toFixed(2);
      const render = (width: number) => cards.flatMap((card) => card.render(width)).join("\n");
      const first = measure(() => render(100));
      const repaint = measure(() => { for (let index = 0; index < 20; index++) render(100); });
      const resized = measure(() => { for (const width of [80, 120, 100]) render(width); });
      for (const card of cards) card.setExpanded(true);
      const expanded = measure(() => render(100));
      if (protocol === "iterm2") assert.equal((first.value.match(/\x1b\]1337;File=/g) ?? []).length, 20);
      if (protocol === "kitty") assert.equal((first.value.match(/\x1b_Ga=T,/g) ?? []).length, 20);
      protocols.push({ protocol, prepareImagesMs: conversionWaitMs, firstPaintMs: first.ms, renderedBytes: Buffer.byteLength(first.value),
        repeatPaintAverageMs: +(repaint.ms / 20).toFixed(2), threeResizesMs: resized.ms, expandedPaintMs: expanded.ms });
    }
    samples.push({ name, images: results.length, jsonlBytes: (await readFile(path)).length, reopenMs: reopen.ms, protocols });
  }
  assert.deepEqual(await store.unpack(preview), original);
  assert(samples[1]!.jsonlBytes < samples[0]!.jsonlBytes / 10);
  console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, platform: `${process.platform}/${process.arch}`, firstPackMs, repeatedPackMs,
    originalBytes: Buffer.from(original.data, "base64").length, previewBytes: Buffer.from(preview.data, "base64").length, samples,
    limits: "One machine, 20 repeated deterministic PNG results. Native persistence/reopen and component rendering; excludes terminal I/O, model requests, and retained-memory claims." }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
