import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { decorateCodexEditor } from "./editor.ts";
import { accentColor } from "./config.ts";
const identity = (text: string) => text;
const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as any;
const keys = { matches: () => false, getKeys: () => [] } as any;
const baseline = new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
baseline.setPaddingX(2);
const decorated = decorateCodexEditor(new CustomEditor(tui, theme, keys, { embedWorkingStatus: true }), accentColor("#83a598", identity));
for (const data of ["hello", "\x1b[D", "界", "\x1b[200~first\nsecond\x1b[201~", "\x7f"]) {
  baseline.handleInput(data); decorated.handleInput(data);
  assert.equal(decorated.getText(), baseline.getText());
  assert.deepEqual(decorated.getCursor(), baseline.getCursor());
}
for (const editor of [baseline, decorated]) editor.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "·" } as any);
const changedHostColor = (text: string) => `\x1b[31m${text}\x1b[39m`;
decorated.borderColor = changedHostColor;
const normal = decorated.render(80).join("\n");
assert(normal.includes("\x1b[38;2;131;165;152m"));
assert(normal.includes("Working"));
assert.equal(decorated.borderColor, changedHostColor);
for (const width of [1, 8, 40, 80]) assert(decorated.render(width).every((line) => visibleWidth(line) <= width));
console.log("native editor input, cursor, paste, accent and working status verified");
