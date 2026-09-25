import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, SessionManager, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setCapabilities, type ImageProtocol, type TUI } from "@earendil-works/pi-tui";
import { referenceOlderImages, retrieveImage } from "../image-history/history.ts";

const root = await mkdtemp(join(tmpdir(), "pi-native-image-preview-"));
process.env.PI_CODING_AGENT_DIR = root;
initTheme("dark", false);
// A one-pixel PNG exercises real native image framing without a large fixture.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438DwHwAGgAJ/EEwb4QAAAABJRU5ErkJggg==";
try {
  const { default: register } = await import("./index.ts");
  const tools = new Map<string, ToolDefinition<any, any>>();
  const handlers = new Map<string, Function>();
  register({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {},
    on: (name: string, handler: Function) => handlers.set(name, handler) } as never);
  const manager = SessionManager.create(root, join(root, "sessions"));
  const ctx = { cwd: root, mode: "rpc", sessionManager: manager };
  await handlers.get("session_start")!({}, ctx);
  const read = tools.get("read")!;
  await writeFile(join(root, "pixel.png"), Buffer.from(png, "base64"));
  const args = { path: "pixel.png", purpose: "Inspect the image" };
  const output = await read.execute("image-read", args, undefined, undefined, ctx as never);
  const result = { role: "toolResult" as const, toolName: "read", toolCallId: "image-read", timestamp: 2,
    ...output, isError: false };
  const originalImage = result.content.find((part) => part.type === "image");
  assert(originalImage, "native read keeps the image in model-visible content");
  const before = JSON.stringify(result);
  manager.appendMessage({ role: "user", content: "Inspect this image", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "image-read", name: "read", arguments: args }],
    api: "openai-responses", provider: "openai", model: "fixture", timestamp: 1, stopReason: "toolUse",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const imageEntry = manager.appendMessage(result);
  manager.appendMessage({ role: "user", content: "Continue", timestamp: 3 });
  const reopened = SessionManager.open(manager.getSessionFile()!);
  const entries = reopened.getBranch();
  const stored = entries.find((entry) => entry.id === imageEntry);
  assert(stored?.type === "message" && stored.message.role === "toolResult");
  assert.equal(JSON.stringify(stored.message), before, "portable JSONL stores the unchanged native result");
  const ui = { requestRender() {} } as TUI;
  const imageCount = (text: string, protocol: ImageProtocol) => protocol === "kitty"
    ? (text.match(/\x1b_G/g) ?? []).length : (text.match(/\x1b\]1337;File=/g) ?? []).length;
  for (const protocol of ["kitty", "iterm2", null] as const) {
    setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
    for (const currentRun of [true, false]) {
      const card = new ToolExecutionComponent("read", "image-read", args, { showImages: true }, read, ui, root);
      if (currentRun) card.markExecutionStarted();
      card.updateResult(currentRun ? result : stored.message);
      for (const expanded of [false, true]) {
        card.setExpanded(expanded);
        for (const width of [12, 80]) {
          const rendered = card.render(width).join("\n");
          assert.equal(imageCount(rendered, protocol), protocol ? 1 : 0,
            "Pi owns exactly one native image preview, for current and restored cards in either expansion state");
        }
      }
      card.setShowImages(false);
      assert.equal(imageCount(card.render(80).join("\n"), protocol), 0, "the host's image visibility preference is respected");
      card.setShowImages(true);
      assert.equal(imageCount(card.render(80).join("\n"), protocol), protocol ? 1 : 0, "native visibility remains reversible");
    }
  }
  assert.equal(JSON.stringify(result), before, "rendering never removes or relocates embedded image data");
  const messages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  const deferred = referenceOlderImages(messages, entries);
  assert.equal(deferred.replaced, 1, "existing image-history deferral still finds the stored source");
  const partIndex = result.content.findIndex((part) => part.type === "image");
  assert.deepEqual(retrieveImage(entries, `${imageEntry}:${partIndex}`), originalImage, "history retrieval preserves original bytes");
  assert((await readFile(manager.getSessionFile()!, "utf8")).includes(originalImage.data), "preview checks leave the portable session intact");
  console.log("native current and restored image previews, visibility preferences and embedded history verified");
} finally { await rm(root, { recursive: true, force: true }); }
