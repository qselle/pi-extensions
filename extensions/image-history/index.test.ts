import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imageHistory from "./index.ts";
import { CONFIG_FILE, loadConfig, type ImageHistoryConfig } from "./config.ts";
import { STATE_TYPE } from "./history.ts";
import { legacyToolResult, writeLegacyBlob } from "./legacy.fixture.ts";
import { LEGACY_PLACEHOLDER, LEGACY_PREVIEW_ENTRY } from "./legacy.ts";
import { STORAGE_STATE_TYPE } from "./pipeline.ts";
import { syntheticPng } from "./png.fixture.ts";
import { ORIGINAL_IMAGE } from "./storage.ts";

function setup(agentDir: string, options: { config?: ImageHistoryConfig; mode?: string; branch?: any[] } = {}) {
  const handlers = new Map<string, Function[]>();
  const renderers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const branch = options.branch ?? [];
  const notices: string[] = [];
  let active = ["read"];
  const pi: any = {
    on: (event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: () => {},
    registerEntryRenderer: (type: string, renderer: Function) => renderers.set(type, renderer),
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", id: `e${branch.length}`, customType, data }),
  };
  imageHistory(pi, { agentDir, ...(options.config ? { config: options.config } : {}) });
  const ctx: any = {
    mode: options.mode ?? "rpc", hasUI: false, cwd: agentDir,
    sessionManager: { getBranch: () => branch, getSessionDir: () => join(agentDir, "sessions"), getSessionFile: () => undefined },
    ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
  };
  const emit = async (event: string, payload: any = {}) => {
    let result: any;
    for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
    return result;
  };
  return { emit, branch, notices, renderers, commands, ctx, active: () => active };
}

const temporary = () => mkdtemp(join(tmpdir(), "pi-image-history-index-"));
const largeImage = () => ({ type: "image" as const, data: syntheticPng(320, 320).toString("base64"), mimeType: "image/png" });

test("config defaults storage on and deferral off; malformed files keep defaults", async () => {
  const agentDir = await temporary();
  try {
    expect(loadConfig(agentDir)).toEqual({ storage: true, deferral: false });
    await writeFile(join(agentDir, CONFIG_FILE), JSON.stringify({ storage: { enabled: false }, deferral: { enabled: true } }));
    expect(loadConfig(agentDir)).toEqual({ storage: false, deferral: true });
    await writeFile(join(agentDir, CONFIG_FILE), "{oops");
    expect(loadConfig(agentDir)).toEqual({ storage: true, deferral: false });
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("stores large new images by default while a branch's /image-store off still wins", async () => {
  const agentDir = await temporary();
  try {
    const h = setup(agentDir);
    await h.emit("session_start");
    // The global default alone does not create the store before an image arrives.
    expect(await readdir(agentDir)).toEqual([]);
    const message = { role: "user", content: [largeImage()], timestamp: 1 };
    const stored = await h.emit("message_end", { message });
    expect(stored.message.content[0][ORIGINAL_IMAGE]).toBeDefined();
    const small = { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 2 };
    expect(await h.emit("message_end", { message: small })).toBeUndefined();

    h.branch.push({ type: "custom", id: "off", customType: STORAGE_STATE_TYPE, data: { version: 1, enabled: false } });
    await h.emit("session_tree");
    expect(await h.emit("message_end", { message })).toBeUndefined();

    const disabled = setup(agentDir, { config: { storage: false, deferral: false } });
    await disabled.emit("session_start");
    expect(await disabled.emit("message_end", { message })).toBeUndefined();
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("configured deferral default activates history_image unless the branch turned it off", async () => {
  const agentDir = await temporary();
  try {
    const h = setup(agentDir, { config: { storage: false, deferral: true } });
    await h.emit("session_start");
    expect(h.active()).toContain("history_image");
    h.branch.push({ type: "custom", id: "off", customType: STATE_TYPE, data: { version: 1, enabled: false } });
    await h.emit("session_tree");
    expect(h.active()).not.toContain("history_image");
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("a resumed sidecar session gets its images back in model context and the transcript", async () => {
  const agentDir = await temporary();
  try {
    const blob = await writeLegacyBlob(agentDir, Buffer.from("legacy screenshot"));
    const image = { type: "image", data: Buffer.from("legacy screenshot").toString("base64"), mimeType: "image/png" };
    const entry = () => ({ type: "message", id: "read", parentId: null, message: legacyToolResult([blob.ref]) });

    // Model context restores without touching the loaded entry outside the terminal UI.
    const rpc = setup(agentDir, { branch: [entry()] });
    await rpc.emit("session_start");
    expect(rpc.branch[0].message.content[1]).toEqual({ type: "text", text: LEGACY_PLACEHOLDER });
    const context = await rpc.emit("context", { messages: [rpc.branch[0].message, { role: "user", content: "next", timestamp: 2 }] });
    expect(context.messages[0].content[1]).toEqual(image);

    // The terminal transcript renders from loaded entries, restored in memory before display.
    const tui = setup(agentDir, { mode: "tui", branch: [entry()] });
    await tui.emit("session_start");
    expect(tui.branch[0].message.content[1]).toEqual(image);
    expect(tui.notices).toEqual([]);

    // A missing sidecar leaves a labeled note and one warning.
    await rm(blob.path);
    const missing = setup(agentDir, { branch: [entry()] });
    await missing.emit("session_start");
    const result = await missing.emit("context", { messages: [missing.branch[0].message, missing.branch[0].message] });
    expect(result.messages[0].content[1].text).toContain("unavailable");
    expect(missing.notices).toHaveLength(1);
    expect(tui.renderers.has(LEGACY_PREVIEW_ENTRY)).toBe(true);
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
