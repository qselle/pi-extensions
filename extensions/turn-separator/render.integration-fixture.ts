import assert from "node:assert/strict";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import extension from "./index.ts";

let renderer: any;
extension({ on() {}, registerEntryRenderer: (_: string, fn: any) => { renderer = fn; } } as any);
const theme = { fg: (_: string, text: string) => `\x1b[2m${text}\x1b[22m` };
for (const data of [undefined, { seconds: 74 }, { seconds: 74, stats: {
  input: 40000, output: 318, cacheRead: 4100, cacheWrite: 100, cost: 0.21, tps: 42, ttftMs: 480,
} }]) {
  const component = renderer({ data }, { expanded: false }, theme);
  for (let width = 0; width <= 160; width++) {
    const lines: string[] = component.render(width);
    assert.equal(lines.length, width === 0 ? 0 : 1);
    for (const line of lines) {
      assert.equal(visibleWidth(line), width === 1 ? 1 : width - 1);
      // Exercise the native text wrapper too: separators must never add a row.
      const rendered = new Text(line, 0, 0).render(width);
      assert.equal(rendered.length, 1);
      assert(rendered.every((row) => visibleWidth(row) <= width));
    }
  }
}
console.log("native separator widths verified");
