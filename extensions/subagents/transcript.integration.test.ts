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

export default function () {
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
      };
      return keys[id]?.includes(data) ?? false;
    },
  };
  let renders = 0;
  let closed = false;
  const tui = { terminal: { rows: 18 }, requestRender() { renders++; } };
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
        { type: "text", text: "Authentication uses signed sessions." },
      ] } },
      { type: "message", message: { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "file contents" }] } },
    ],
  };
  const viewer = new LiveTranscriptViewer(() => transcript, theme, keybindings, tui, () => { closed = true; });
  const output = viewer.render(60);
  const text = output.join("\\n");
  for (const expected of ["Subagent · audit", "provider/model:high", "Task", "Thinking", "Tool · read", "Agent", "Tool result · read"]) {
    if (!text.includes(expected)) throw new Error("missing transcript section: " + expected);
  }
  if (output.some((line) => line.length > 60)) throw new Error("transcript exceeded render width");
  viewer.handleInput("up");
  viewer.handleInput("end");
  viewer.handleInput("q");
  if (renders < 2 || !closed) throw new Error("transcript controls did not update and close");
}
`, "utf8");

  try {
    const result = Bun.spawnSync({
      cmd: ["pi", "--no-extensions", "-e", script, "--list-models"],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
