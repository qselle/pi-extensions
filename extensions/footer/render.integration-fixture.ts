import assert from "node:assert/strict";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderFooter, type FooterView } from "./render.ts";

const colors: Array<{ color: string; value: string }> = [];
const theme = { fg(color: string, value: string) { colors.push({ color, value }); return `\x1b[36m${value}\x1b[39m`; } };
const sample: FooterView = { session: "Footer refresh", model: "GPT-5.6 Sol high", provider: "openai-codex", badges: ["fast"],
  usage: { tokens: 15480, contextWindow: 258000, percent: 6 }, totals: { input: 1200, output: 521, cacheRead: 8400, cacheWrite: 400, cost: 0.21 },
  directory: "~/pi-extensions", branch: "main", git: "git changed 2 new 1" };
const line = (input: FooterView, width: number) => renderFooter(input, width, theme).map(stripTerminalSequences).join("\n");
const wide = line(sample, 280);
assert(wide.startsWith(" GPT-5.6 Sol high · Footer refresh · openai-codex · fast"), wide);
assert(wide.endsWith("~/pi-extensions · main · git changed 2 new 1"), wide);
const telemetry = ["context 6% 15.5K/258K", "prompt 10K", "in 1.2K out 521", "cache read 8.4K", "cache write 400", "cache hit 84%", "$0.21"];
for (const field of telemetry) assert(wide.includes(field), wide);
assert(wide.includes("15.5K/258K · prompt 10K · in 1.2K out 521"));
assert(colors.every(({ color }) => ["accent", "muted", "text", "dim"].includes(color)), "normal telemetry must use the quiet palette");
assert(colors.filter(({ color }) => color === "accent").every(({ value }) => value === sample.model), "only the model gets accent color");
for (const label of ["context", "in", "out", "cache read", "cache write", "cache hit", "changed", "new"]) {
  assert(colors.some(({ color, value }) => color === "muted" && value === label), `${label} must remain legible`);
}
assert(colors.some(({ color, value }) => color === "text" && value === "84%"));
assert(colors.some(({ color, value }) => color === "text" && value === "$0.21"));
assert(colors.some(({ color, value }) => color === "muted" && value === "Footer refresh"));
assert(colors.filter(({ color }) => color === "dim").every(({ value }) => value === " · " || value === " │ "));

// Always one terminal row, even with Unicode names and many long statuses.
const manyStatuses = new Map(Array.from({ length: 8 }, (_, index) => [`status-${index}`, "running ".repeat(20)]));
for (const session of ["Footer refresh", "界🌍é".repeat(25)]) {
  for (let width = 0; width <= 240; width++) {
    const input = { ...sample, session, model: "routed.provider.".repeat(30) + " high", directory: "/very/long/".repeat(30), branch: "feature/".repeat(40), statuses: manyStatuses };
    const result = renderFooter(input, width, theme);
    assert.equal(result.length, width > 0 ? 1 : 0, `footer wrapped at ${width}`);
    assert(result.every((row) => visibleWidth(row) <= width), `overflow at ${width}`);
    const plain = result.map(stripTerminalSequences).join("");
    assert(!plain.includes("�") && !/[\n\r\t\x1b]/.test(plain));
    if (width >= 12) assert(plain.includes("context 6%"), `lost context at ${width}: ${plain}`);
    if (width >= 20) assert(plain.includes("$0.21"), `lost cost at ${width}: ${plain}`);
    if (width >= 40) assert(plain.includes("high"), `lost model effort at ${width}: ${plain}`);
    assert(!/\bctx\b|[↓↑▰▱]|\bR\d|\bW\d|\bhit\d/.test(plain), `cryptic label at ${width}: ${plain}`);
  }
}
for (const width of [60, 80, 100, 120, 180]) {
  const rendered = line(sample, width);
  for (const field of ["GPT-5.6 Sol high", "context 6%", "$0.21"]) assert(rendered.includes(field), `lost ${field} at ${width}: ${rendered}`);
  if (width >= 80) assert(rendered.includes("in 1.2K out 521"), rendered);
  if (width >= 100) assert(rendered.includes("15.5K/258K"), rendered);
  assert(rendered.endsWith(width >= 100 && width < 180 ? "pi-extensions · main" : width < 180 ? "pi-extensions" : "git changed 2 new 1"), rendered);
}
for (const field of telemetry) assert(line(sample, 180).includes(field), `missing roomy metric ${field}`);
for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
  for (const width of [40, 60, 100]) {
    const rendered = line({ ...sample, model: `very-long-model-name ${effort}` }, width);
    assert(rendered.includes(` ${effort}`), `lost effort at ${width}: ${rendered}`);
  }
}
const unknown = line({ ...sample, usage: undefined, contextWindow: 258000 }, 280);
assert(unknown.includes("context ?% ?/258K"), unknown);
const empty = line({ ...sample, totals: { input: 0, output: 0, cost: 0 }, usage: undefined }, 280);
for (const field of ["context ?% ?/?", "in 0 out 0", "$0.00"]) assert(empty.includes(field), empty);
assert(!empty.includes("cache") && !empty.includes("prompt 0"), "unused cache fields add no clutter");
assert(!line({ ...sample, totals: { ...sample.totals, cacheWrite: 0 } }, 280).includes("cache write"));
assert(line({ ...sample, totals: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }, 280).includes("cache hit 0%"));

// Missing reports stay unknown; partial recorded totals are lower bounds.
colors.length = 0;
const missing = line({ ...sample, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  responses: 1, missing: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 1 } } }, 280);
for (const field of ["in ? out ?", "cache read ?", "cache write ?", "cache hit ?", "$?"]) assert(missing.includes(field), missing);
assert(!colors.some(({ color }) => color === "warning" || color === "error"));
colors.length = 0;
const partial = line({ ...sample, totals: { ...sample.totals, responses: 2, missing: { input: 1, cacheRead: 1, cost: 1 } } }, 280);
for (const field of ["in ≥1.2K out 521", "cache read ≥8.4K", "prompt ≥10K", "cache hit ?", "≥$0.21"]) assert(partial.includes(field), partial);
assert(colors.some(({ color, value }) => color === "warning" && value === "≥$0.21"));
assert(colors.some(({ color, value }) => color === "muted" && value === "?"));
assert(!partial.includes("cache hit 84%"));

for (const [percent, expected] of [[80, "warning"], [97, "error"]] as const) {
  colors.length = 0;
  line({ ...sample, usage: { tokens: 250000, percent, contextWindow: 258000 } }, 280);
  assert(colors.some(({ color, value }) => color === expected && value.includes(`${percent}%`)));
}
const conflicts = { ...sample, git: "git conflicts 2 staged 5 changed 8 new 3 ahead 2 behind 1", gitConflicts: true };
for (const width of [40, 60, 80, 120]) {
  const rendered = line(conflicts, width);
  assert(rendered.includes("conflicts 2"), `lost conflict at ${width}: ${rendered}`);
  assert(rendered.includes("context 6%") && rendered.includes("$0.21"), rendered);
}
colors.length = 0;
line(conflicts, 300);
assert(colors.some(({ color, value }) => color === "error" && value === "2"));
assert(colors.some(({ color, value }) => color === "text" && value === "5"), "ordinary staged changes are not warnings");
const withStatuses = line({ ...sample, statuses: [["verify", "verifying\ntests"], ["agents", "agents 2"]] }, 300);
assert(withStatuses.includes("agents 2 verifying tests"), withStatuses);
const sanitized = line({ ...sample, session: "name\x1b[31m\nnew\x1b[0m", statuses: [["verify", "safe\x1b]2;bad-title\x07 text"]] }, 300);
assert(sanitized.includes("name new") && sanitized.includes("safe text") && !sanitized.includes("bad-title"));
console.log("footer rendering verified");
