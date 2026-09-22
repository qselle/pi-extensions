import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, setCapabilityOverrides, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import headless from "@xterm/headless";
import { getHyperlinkMode, hasDanglingLink, setHyperlinkMode } from "../../lib/links.ts";
import { formatSearch, type SearchResult } from "./client.ts";
import extension from "./index.ts";

const tools = new Map<string, any>();
const commands = new Map<string, any>();
setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+e", description: "Expand tools" } }));
extension({
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: (name: string, definition: any) => commands.set(name, definition),
} as never);
assert.deepEqual([...tools.keys()], ["web_search", "web_read"]);
assert(commands.has("web"));
const keyNames = ["EXA_API_KEY", "FIRECRAWL_API_KEY", "MISTRAL_API_KEY"];
const savedKeys = keyNames.map((key) => process.env[key]);
try {
  for (const key of keyNames) delete process.env[key];
  const notices: string[] = [];
  const ctx = { ui: { notify: (text: string) => notices.push(text) } };
  await commands.get("web").handler("", ctx);
  assert(notices.at(-1)!.includes("Exa · public access · automatic"));
  assert(!notices.at(-1)!.includes("not configured"));
  process.env.EXA_API_KEY = "fixture-never-send";
  process.env.FIRECRAWL_API_KEY = "fixture-never-send";
  await commands.get("web").handler("", ctx);
  assert(notices.at(-1)!.includes("Exa · API key · automatic"));
  assert(notices.at(-1)!.includes("Firecrawl (select with provider)"));
  assert(!notices.join("\n").includes("fixture-never-send"));
} finally {
  keyNames.forEach((key, index) => { if (savedKeys[index] === undefined) delete process.env[key]; else process.env[key] = savedKeys[index]; });
}
const theme = { fg: (_: string, text: string) => text };
const search = tools.get("web_search");
const result = { content: [{ type: "text", text: "source content" }], details: {
  quality: "deep", searchType: "deep",
  domains: ["example.com/API"], excludedDomains: ["example.com/API/old"], maxAgeHours: 0, category: "news",
  dateRange: { start: "2024-01-01", end: "2024-01-31" },
  diagnostics: { received: 4, invalid: 1, duplicate: 1, outsideDomains: 1, omitted: 0 },
  provider: "exa", query: "query", results: [{ url: "https://example.com/", title: "A long source title 界".repeat(10), snippet: "snippet" }],
} satisfies SearchResult };
for (const width of [0, 1, 12, 24, 40, 80]) {
  const component = search.renderResult(result, { expanded: false, isPartial: false }, theme);
  const lines = component.render(width);
  assert(lines.every((line: string) => visibleWidth(line) <= width));
  if (width >= 24) assert(lines.some((line: string) => line.includes("example.com")), "A long title must not hide its source.");
}
assert(search.renderResult(result, { expanded: false, isPartial: false }, theme).render(40)[0].includes("1 source"));
assert(!search.renderResult(result, { expanded: false, isPartial: false }, theme).render(40)[0].includes("1 sources"));
assert(search.renderResult(result, { expanded: false, isPartial: false }, theme).render(80).join("\n").includes("3 rows excluded"));
assert(search.renderResult(result, { expanded: false, isPartial: false }, theme).render(80).join("\n").includes("Exa · deep"));
assert(search.renderResult(result, { expanded: false, isPartial: false }, theme).render(120).join("\n").includes("fresh fetch"));
assert(search.renderResult(result, { expanded: false, isPartial: false }, theme).render(120).join("\n").includes("example.com/API"));
assert(search.renderResult(result, { expanded: false, isPartial: false }, theme).render(80).join("\n").includes("ctrl+e to expand"));
assert.equal(search.renderShell, "self");
const citations = { ...result, details: { ...result.details, provider: "mistral", quality: "balanced", searchType: "web_search citations" } };
const citationView = search.renderResult(citations, { expanded: false, isPartial: false }, theme);
assert(citationView.render(80).join("\n").includes("model-selected citations"));
for (const width of [1, 12, 40, 80]) assert(citationView.render(width).every((line: string) => visibleWidth(line) <= width));
const expanded = search.renderResult(result, { expanded: true, isPartial: false }, theme).render(80).join("\n");
assert(expanded.includes("snippet"));
assert(expanded.includes("Filtered: 1 invalid"));
assert(!expanded.includes("source content"));
const failure = search.renderResult({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme).render(80).join("\n");
assert(failure.includes("failed"));
const reader = tools.get("web_read");
const failed = { content: [{ type: "text", text: "\x1b]0;hidden\x07Check EXA_API_KEY.\nNo request was sent." }] };
for (const tool of [search, reader]) {
  const component = tool.renderResult(failed, { expanded: false, isPartial: false }, theme);
  assert(component.render(40).join("\n").includes("Check EXA_API_KEY."));
  assert(!component.render(80).join("\n").includes("hidden"));
  for (let width = 0; width <= 80; width++) assert(component.render(width).every((line: string) => visibleWidth(line) <= width));
}
for (const [provider, received, expected] of [["exa", 0, "No matches returned"], ["exa", 2, "No usable sources remain"], ["mistral", 0, "No web citations returned"]] as const) {
  const empty = { ...result, details: { ...result.details, provider, results: [], diagnostics: { received, invalid: received, duplicate: 0, outsideDomains: 0, omitted: 0 } } };
  assert(search.renderResult(empty, { expanded: false, isPartial: false }, theme).render(40).join("\n").includes(expected));
}
for (const results of [[], result.details.results]) {
  const warned = { ...result, details: { ...result.details, provider: "firecrawl", results, diagnostics: undefined, warning: "Partial provider response" } };
  const view = search.renderResult(warned, { expanded: false, isPartial: false }, theme);
  const text = view.render(40).join("\n");
  assert(text.includes("Provider warning"));
  if (!results.length) {
    assert(text.includes("No sources returned"));
    assert(!text.includes("No matches returned"));
  }
  for (let width = 1; width <= 80; width++) assert(view.render(width).every((line: string) => visibleWidth(line) <= width));
}
const priorLinks = getHyperlinkMode();
try {
  for (const mode of ["always", "never"] as const) {
    setHyperlinkMode(mode);
    const linked = search.renderResult(result, { expanded: false, isPartial: false }, theme);
    for (let width = 0; width <= 100; width++) {
      const lines = linked.render(width);
      assert(lines.every((line: string) => visibleWidth(line) <= width && !hasDanglingLink(line)));
    }
    assert.equal(linked.render(40).join("\n").includes("\x1b]8;;https://example.com/"), mode === "always");
  }
  setHyperlinkMode("never");
  const longOrigin = { ...result, details: { ...result.details, results: [{ ...result.details.results[0]!, url: "https://example.com.another-source.test:8443/page" }] } };
  const longView = search.renderResult(longOrigin, { expanded: false, isPartial: false }, theme);
  assert(longView.render(60).join("\n").includes("example.com.another-source.test:8443"));
  assert(longView.render(24).some((line: string) => stripTerminalSequences(line).trimStart().startsWith("1.") && stripTerminalSequences(line).endsWith("…")), "Clipped origins must not look complete.");
  const invalid = { ...result, details: { ...result.details, results: [{ ...result.details.results[0]!, url: "javascript:bad()" }] } };
  assert(search.renderResult(invalid, { expanded: false, isPartial: false }, theme).render(40).join("\n").includes("Invalid source URL"));
} finally { setHyperlinkMode(priorLinks); }
for (const pagination of [undefined, { state: "more", nextOffset: 42 }, { state: "complete", nextOffset: null }, { state: "past_end", nextOffset: null }]) {
  const details = { url: "https://example.com", truncated: false, pagination };
  const component = reader.renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme);
  for (const width of [1, 12, 80]) assert(component.render(width).every((line: string) => visibleWidth(line) <= width));
  if (pagination?.state === "more") assert(component.render(24).join("\n").includes("next offset 42"));
}
const fallbackView = reader.renderResult({ content: [], details: { url: "https://example.com", reader: "exa", access: "keyless", truncated: true, fallback: { from: "ax", reason: "ax returned no readable content." } } }, { expanded: false, isPartial: false }, theme);
assert(fallbackView.render(120).join("\n").includes("ax fallback"));
for (const width of [1, 12, 40, 80]) assert(fallbackView.render(width).every((line: string) => visibleWidth(line) <= width));

// Inspect actual host cards too: their padding reduces the renderer's available width.
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-render-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "themes"));
copyFileSync(join(import.meta.dir, "../../themes/gruvbox-dark.json"), join(agentDir, "themes/gruvbox-dark.json"));
setCapabilityOverrides({ trueColor: true });
initTheme("gruvbox-dark", false);
try {
  const frames: { name: string; width: number; lines: string[]; background?: number }[] = [];
  const sources: SearchResult = { provider: "exa", access: "keyless", query: "research interface", quality: "balanced", searchType: "auto", elapsedMs: 1240, results: [
    { title: "Readable terminal workflows and careful source attribution", url: "https://example.com/guide", snippet: "Fixture source one." },
    { title: "A long Unicode title 界界界 across narrow terminal windows", url: "https://docs.example.org/usage", snippet: "Fixture source two." },
    { title: "Page extraction and continuation", url: "https://example.net/reading", snippet: "Fixture source three." },
  ] };
  for (const width of [24, 40, 80]) {
    const card = new ToolExecutionComponent("web_search", "preview-search", { query: sources.query }, {}, search, { requestRender() {} } as never, process.cwd());
    card.updateResult({ content: [{ type: "text", text: formatSearch(sources) }], details: sources, isError: false });
    const lines = card.render(width);
    assert(lines.every((line) => visibleWidth(line) <= width && !hasDanglingLink(line)));
    const plain = lines.map(stripTerminalSequences).join("\n");
    assert(plain.includes("public"), plain);
    assert(plain.includes("Searched"), plain);
    for (const hit of sources.results) assert(plain.includes(new URL(hit.url).host));
    frames.push({ name: "search", width, lines });
    card.setExpanded(true);
    const expandedLines = card.render(width);
    assert(expandedLines.every((line) => visibleWidth(line) <= width && !hasDanglingLink(line)));
    assert(expandedLines.map(stripTerminalSequences).join("").includes("Fixture source"));
    frames.push({ name: "search-expanded", width, lines: expandedLines });
    const page = new ToolExecutionComponent("web_read", "preview-page", { url: "https://example.com/guide" }, {}, reader, { requestRender() {} } as never, process.cwd());
    page.updateResult({ content: [], details: { url: "https://example.com/guide", truncated: false, pagination: { state: "more", nextOffset: 42 } }, isError: false });
    const pageLines = page.render(width);
    assert(pageLines.every((line) => visibleWidth(line) <= width));
    assert(pageLines.map(stripTerminalSequences).join("\n").includes("next offset 42"));
    frames.push({ name: "read-continuation", width, lines: pageLines });
    const errorCard = new ToolExecutionComponent("web_search", "preview-failure", { query: "research interface" }, {}, search, { requestRender() {} } as never, process.cwd());
    errorCard.updateResult({ content: [{ type: "text", text: "Check EXA_API_KEY. Configured key was rejected." }], isError: true });
    const errorLines = errorCard.render(width);
    assert(errorLines.every((line) => visibleWidth(line) <= width));
    assert(errorLines.map(stripTerminalSequences).join("\n").includes("EXA_API_KEY"));
    frames.push({ name: "search-failure", width, lines: errorLines, background: 0x3c1f1e });
  }
  for (const frame of frames) {
    const terminal = new headless.Terminal({ cols: frame.width, rows: frame.lines.length, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write(frame.lines.join("\r\n"), resolve));
      for (let y = 1; y < frame.lines.length; y++) {
        for (let x = 0; x < frame.width; x++) {
          const cell = terminal.buffer.active.getLine(y)!.getCell(x)!;
          assert(cell.isBgDefault(), "Self-rendered tools must share the transcript background.");
        }
      }
    } finally { terminal.dispose(); }
  }
  if (process.env.PI_WEB_PREVIEW_FILE) writeFileSync(process.env.PI_WEB_PREVIEW_FILE, JSON.stringify(frames));
} finally { rmSync(agentDir, { recursive: true, force: true }); }
console.log("web tools and native renderers verified");
