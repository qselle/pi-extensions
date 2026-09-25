import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, estimateTokens, initTheme, resizeImage, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { setCapabilities, type TUI } from "@earendil-works/pi-tui";
import extension from "./index.ts";
import { ImageStore, ORIGINAL_IMAGE, isImagePart, originalReference } from "./storage.ts";
import { storedImages } from "./pipeline.ts";
import { syntheticPng } from "./png.fixture.ts";
import { OriginalImageViewer, prepareImageForViewer } from "./viewer.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ORIGINAL_GRACE_MS } from "./cleanup.ts";

const root = await mkdtemp(join(tmpdir(), "pi-image-store-native-"));
process.env.PI_CODING_AGENT_DIR = root; process.env.PI_OFFLINE = "1"; process.env.ANTHROPIC_API_KEY = "synthetic-key";
globalThis.fetch = (() => { throw new Error("Network forbidden in image storage fixture"); }) as unknown as typeof fetch;
const png = syntheticPng();
const original: ImageContent = { type: "image", data: png.toString("base64"), mimeType: "image/png" };
const model = getModels("anthropic")[0]!;
let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
const errors: string[] = [];
const create = async (manager: SessionManager) => {
  const services = await createAgentSessionServices({ cwd: root, agentDir: root,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, images: { autoResize: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, extensionFactories: [extension] } });
  const result = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  await result.session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
  return result.session;
};
try {
  initTheme("dark", false);
  await writeFile(join(root, "image.png"), png);
  const manager = SessionManager.create(root, join(root, "sessions"));
  session = await create(manager);
  await session.prompt("/image-store on");
  let calls = 0, phase: "first" | "deferred" = "first";
  session.agent.streamFunction = async (_model, context) => {
    const images = context.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter(isImagePart) : []);
    assert(!JSON.stringify(context.messages).includes(ORIGINAL_IMAGE), "storage metadata never reaches the provider");
    if (phase === "deferred") assert.equal(images.length, 0, "old images are deferred before original bytes are read");
    else { assert(images.length > 0); assert(images.every((image) => image.data === original.data)); }
    const tool = calls++ === 0;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
      content: tool ? [{ type: "toolCall", id: "read", name: "read", arguments: { path: "image.png" } }] : [{ type: "text", text: "Done" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(); return stream;
  };
  await session.prompt("Compare the attachment with image.png", { images: [original] });
  assert.equal(calls, 2);
  const locations = storedImages(manager.getBranch()); assert.equal(locations.length, 2);
  assert.equal(new Set(locations.map(({ image }) => originalReference(image)!.hash)).size, 1);
  assert.equal((await readdir(join(root, "image-store", "originals"))).length, 1);
  const firstJsonl = await readFile(manager.getSessionFile()!, "utf8");
  assert(!firstJsonl.includes(original.data)); assert(Buffer.byteLength(firstJsonl) < png.length / 10);
  for (const { image } of locations) {
    assert(Buffer.from(image.data, "base64").length <= 32768);
    assert.equal(estimateTokens({ role: "user", content: [image], timestamp: 1 }), estimateTokens({ role: "user", content: [original], timestamp: 1 }));
  }
  const readEntry = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult")!;
  assert(readEntry.type === "message" && readEntry.message.role === "toolResult");
  setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
  for (const expanded of [false, true]) {
    const card = new ToolExecutionComponent("read", "read", { path: "image.png" }, { showImages: true }, undefined, { requestRender() {} } as TUI, root);
    card.updateResult(readEntry.message); card.setExpanded(expanded);
    assert.equal((card.render(80).join("\n").match(/\x1b\]1337;File=/g) ?? []).length, 1);
  }
  let closed = false;
  const viewer = new OriginalImageViewer(original, locations[0]!.reference, session.extensionRunner.createContext().ui.theme, 24, () => { closed = true; });
  assert.equal((viewer.render(80).join("\n").match(/\x1b\]1337;File=/g) ?? []).length, 1);
  viewer.handleInput("q"); assert(closed);
  setCapabilities({ images: null, trueColor: true, hyperlinks: false }); viewer.invalidate();
  for (const width of [1, 20, 80]) assert(viewer.render(width).every((line) => visibleWidth(line) <= width));
  const jpeg = await resizeImage(syntheticPng(512, 512), "image/png", { maxWidth: 128, maxHeight: 128, maxBytes: 4000 });
  assert.equal(jpeg!.mimeType, "image/jpeg");
  const jpegPart: ImageContent = { type: "image", data: jpeg!.data, mimeType: jpeg!.mimeType };
  assert.equal(await prepareImageForViewer(jpegPart), jpegPart, "fallback terminals do not pay conversion costs");
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const kittyImage = await prepareImageForViewer(jpegPart);
  assert.equal(kittyImage.mimeType, "image/png");
  assert.equal(Buffer.from(kittyImage.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const kittyViewer = new OriginalImageViewer(kittyImage, "jpeg", session.extensionRunner.createContext().ui.theme, 24, () => {});
  assert(kittyViewer.render(80).join("\n").includes(kittyImage.data.slice(0, 32)));
  assert.equal(jpegPart.mimeType, "image/jpeg", "terminal conversion never changes the original");
  const firstLeaf = manager.getLeafId()!;
  await session.prompt("/image-history on"); phase = "deferred";
  await session.prompt("Continue without the images");
  const retrieve = async () => {
    const runner = session!.extensionRunner;
    const result = await runner.getToolDefinition("history_image")!.execute("retrieve", { reference: locations[0]!.reference }, undefined, undefined, runner.createContext());
    assert.deepEqual(result.content[1], original);
  };
  await retrieve();
  await session.reload(); await retrieve();
  let retrievalRequests = 0;
  session.agent.streamFunction = async (_model, context) => {
    const images = context.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter(isImagePart) : []);
    assert.equal(images.length, retrievalRequests === 0 ? 0 : 1, "retrieval adds exactly one original to the current model turn");
    if (images.length) assert.deepEqual(images[0], original);
    const tool = retrievalRequests++ === 0;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
      content: tool ? [{ type: "toolCall", id: "history", name: "history_image", arguments: { reference: locations[0]!.reference } }] : [{ type: "text", text: "Inspected the original" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(); return stream;
  };
  await session.prompt("Retrieve the earlier image");
  assert.equal(retrievalRequests, 2);
  assert.equal(storedImages(manager.getBranch()).length, 3);
  const editOriginal: ImageContent = { type: "image", mimeType: "image/png", data: syntheticPng(640, 640).toString("base64") };
  const editPreview = await new ImageStore(join(root, "image-store")).pack(editOriginal);
  const editId = manager.appendContextEdit(locations[0]!.reference.split(":")[0]!, { content: [editPreview] });
  const retrievedEdit = await session.extensionRunner.getToolDefinition("history_image")!.execute("retrieve-edit", { reference: `${editId}:0` }, undefined, undefined, session.extensionRunner.createContext());
  assert.deepEqual(retrievedEdit.content[1], editOriginal);
  const exported = join(root, "portable.jsonl");
  const beforeExport = await readFile(manager.getSessionFile()!, "utf8");
  await session.prompt(`/image-store export ${exported}`);
  assert.equal(await readFile(manager.getSessionFile()!, "utf8"), beforeExport);
  const portable = SessionManager.open(exported);
  assert.equal(storedImages(portable.getBranch()).length, 0);
  assert.equal(portable.getBranch().flatMap((entry) => entry.type === "message" && "content" in entry.message && Array.isArray(entry.message.content) ? entry.message.content.filter(isImagePart) : []).length, 3);
  assert((await readFile(exported, "utf8")).includes(original.data));
  assert(!JSON.stringify(portable.getEntries()).includes(ORIGINAL_IMAGE), "portable export resolves context edits too");
  assert(JSON.stringify(portable.buildSessionContext().messages).includes(editOriginal.data));
  const fork = manager.createBranchedSession(firstLeaf)!;
  assert(fork);
  session.dispose(); session = await create(SessionManager.open(fork));
  await session.prompt("/image-history on"); await retrieve();
  await session.prompt("/image-store off"); await retrieve();
  await session.prompt("/image-history off");
  const activeManager = session.sessionManager as SessionManager;
  const beforeOmission = await session.extensionRunner.emitContext(activeManager.buildSessionContext().messages);
  const countImages = (messages: readonly any[]) => messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter(isImagePart) : []).length;
  assert.equal(countImages(beforeOmission), 2);
  const sourceId = locations[0]!.reference.split(":")[0]!;
  activeManager.appendContextEdit(sourceId, null);
  const afterOmission = await session.extensionRunner.emitContext(activeManager.buildSessionContext().messages);
  assert.equal(countImages(afterOmission), 1, "hydration does not re-add canonically omitted attachments");
  const embedded = { role: "user" as const, content: [original], timestamp: Date.now() };
  const transformed = await session.extensionRunner.emitMessageEnd({ type: "message_end", message: embedded });
  assert.equal(transformed, undefined, "storage off leaves new image bytes embedded");
  const keep = activeManager.appendMessage({ role: "user", content: "After compaction", timestamp: Date.now() });
  activeManager.appendCompaction("Older images are available in history.", keep, 2400);
  await session.prompt("/image-history on");
  assert.equal(countImages(await session.extensionRunner.emitContext(activeManager.buildSessionContext().messages)), 0);
  await retrieve();
  session.dispose(); session = await create(SessionManager.open(activeManager.getSessionFile()!));
  await retrieve();
  const orphanStore = new ImageStore(join(root, "image-store"));
  const orphan = await orphanStore.pack({ type: "image", mimeType: "image/png", data: syntheticPng(512, 512).toString("base64") });
  const orphanPath = join(orphanStore.blobsDirectory, `${originalReference(orphan)!.hash}.blob`);
  const old = new Date(Date.now() - ORIGINAL_GRACE_MS * 2); await utimes(orphanPath, old, old);
  const runner = session.extensionRunner;
  let confirmations = 0;
  let confirmation: "decline" | "navigate" | "accept" = "decline";
  const commandContext = runner.createCommandContext();
  const ui = { ...commandContext.ui, notify() {}, confirm: async () => {
    confirmations++;
    if (confirmation === "navigate") await runner.emit({ type: "session_tree", newLeafId: session!.sessionManager.getLeafId()!, oldLeafId: null, fromExtension: false });
    return confirmation !== "decline";
  } };
  const gc = () => runner.getCommand("image-store")!.handler("gc", { ...commandContext, mode: "tui", ui });
  await gc(); assert.equal(confirmations, 1); assert((await readFile(orphanPath)).length > 0);
  confirmation = "navigate"; await gc(); assert.equal(confirmations, 2); assert((await readFile(orphanPath)).length > 0);
  confirmation = "accept"; await gc(); assert.equal(confirmations, 3); await assert.rejects(readFile(orphanPath));
  await retrieve();
  assert.deepEqual(errors, []);
  console.log("native stored-image roundtrip, deferral, reload, fork and portable export verified");
} finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
