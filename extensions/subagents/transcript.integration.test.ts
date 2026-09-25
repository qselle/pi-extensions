import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const transcriptModule = resolve(import.meta.dir, "transcript.ts");

test("renders and navigates a live transcript with Pi's real TUI utilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-transcript-integration-"));
  const script = join(directory, "verify-transcript.ts");
  await writeFile(script, `
import { LiveTranscriptViewer } from ${JSON.stringify(transcriptModule)};
import { initTheme } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
import { visibleWidth } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-tui"))};
initTheme("dark");
const plain = (rows) => rows.join("\\n").replace(/\\x1b\\[[0-9;]*m/g, "");

function verify() {
  const theme = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    italic: (value) => value,
    strikethrough: (value) => value,
  };
  const keybindings = {
    matches(data, id) {
      const keys = {
        "tui.select.cancel": ["escape", "ctrl+c"],
        "tui.select.up": ["up"],
        "tui.select.down": ["down"],
        "tui.select.pageUp": ["pageUp"],
        "tui.select.pageDown": ["pageDown"],
        "tui.select.confirm": ["\\r"],
      };
      return keys[id]?.includes(data) ?? false;
    },
  };
  let renders = 0;
  let closed = false;
  const tui = { terminal: { rows: 42 }, requestRender() { renders++; } };
  const transcript = {
    agent: {
      id: "a",
      name: "audit",
      task: "Inspect authentication and report findings",
      contextMode: "summary",
      status: "running",
      cwd: "/tmp/project",
      model: "provider/model",
      thinking: "high",
      startedAt: 1,
      output: "",
      activity: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    },
    entries: [
      { type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: "Trace the auth flow" },
        { type: "toolCall", name: "read", arguments: { path: "src/auth.ts" } },
        { type: "text", text: "Authentication uses **signed sessions**." },
      ] } },
      { type: "message", message: { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "file contents" }] } },
    ],
  };
  const viewer = new LiveTranscriptViewer(() => transcript, theme, keybindings, tui, () => { closed = true; });
  const output = viewer.render(60);
  const text = plain(output);
  for (const expected of ["Subagent · audit", "provider/model · high", "Task", "Tool call · read", "Assistant", "Tool result · read", "signed sessions"]) {
    if (!text.includes(expected)) throw new Error("missing transcript section: " + expected);
  }
  if (text.includes("**signed sessions**") || text.includes("Trace the auth flow")) throw new Error("Markdown or collapsed thinking regressed");
  viewer.handleInput("t");
  if (!plain(viewer.render(80)).includes("Trace the auth flow")) throw new Error("thinking toggle did not reveal reasoning");
  viewer.handleInput("t");
  for (const width of [0, 1, 2, 6, 20, 60, 120]) {
    if (viewer.render(width).some((line) => visibleWidth(line) > width)) throw new Error("transcript exceeded render width");
  }
  viewer.focused = true;
  viewer.handleInput("/");
  viewer.handleInput("\\x1b[200~signed sessions\\x1b[201~");
  viewer.handleInput("\\r");
  if (!plain(viewer.render(90)).includes("1/1 matches")) throw new Error("child transcript Markdown search failed");
  transcript.agent.status = "completed";
  viewer.refresh();
  if (!plain(viewer.render(90)).includes("completed")) throw new Error("child status header did not refresh");
  tui.terminal.rows = 18;
  viewer.render(60);
  viewer.handleInput("up");
  viewer.handleInput("\\x1b[F");
  viewer.handleInput("q");
  if (renders < 2 || !closed) throw new Error("transcript controls did not update and close");
}
await verify();
console.log("native assertions executed");
`, "utf8");

  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, script],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent") },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("native assertions executed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
