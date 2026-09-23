import assert from "node:assert/strict";
import { initTheme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as plain } from "node:util";
import { Lexer } from "marked";
import { highlightSyntax } from "../../lib/syntax.ts";
import extension from "./index.ts";
initTheme("dark", false);
let transform: any;
let startSession: any;
await extension({ registerMarkdownTransformer: (callback: any) => { transform = callback; }, on: (event: string, callback: any) => {
  if (event === "session_start") startSession = callback;
} } as never);
let themeName = "gruvbox-dark";
startSession({}, { ui: { get theme() { return { name: themeName }; } } });
const source = '```typescript src/app.ts\nconst message = "hello";\n```';
const context = { messageType: "assistant", availableWidth: 80, isStreaming: false };
const transformed = transform(source, context);
assert(transformed.includes('` typescript · src/app.ts `\n\n```\n'));
assert.equal(transform(source, { ...context, messageType: "user" }), source);
assert.equal(transform(source, { ...context, messageType: "assistant-thinking" }), transformed);
const component = new Markdown(source, 0, 0, { ...getMarkdownTheme(), codeBlockIndent: "│ " }, undefined, { transform: (text, width) => transform(text, { ...context, availableWidth: width }) });
for (const width of [1, 20, 80]) {
  const rendered = component.render(width);
  assert(rendered.every((line) => visibleWidth(line) <= width));
  if (width === 80) {
    assert(rendered.join("\n").includes("src/app.ts"));
    assert(rendered.some((row) => row.includes("│ ")));
    assert(rendered.join("\n").includes(highlightSyntax('const message = "hello";', "typescript")![0]!));
    assert(plain(rendered.join("\n")).includes('│ const message = "hello";'));
  }
}
const open = source.slice(0, -4);
assert(transform(open, { ...context, isStreaming: true }).includes('` typescript · src/app.ts `\n\n```\n'));
const streaming = new Markdown(open, 0, 0, getMarkdownTheme(), undefined, { transform: (text, width) => transform(text, { ...context, isStreaming: true, availableWidth: width }) });
assert(streaming.render(80).join("\n").includes(highlightSyntax('const message = "hello";', "typescript")![0]!));
const mixed = `${source}\n\nProse remains outside the code.\n\n\`\`\`zig\nconst std = @import("std");\n\`\`\`\n\nTail`;
const tokens = new Lexer().lex(transform(mixed, context));
assert.equal(tokens.filter((token) => token.type === "code").length, 2);
assert(tokens.some((token) => token.type === "paragraph" && token.raw === "Prose remains outside the code."));
assert(tokens.some((token) => token.type === "paragraph" && token.raw === "Tail"));
const zig = tokens.findLast((token) => token.type === "code");
assert(zig?.type === "code" && zig.text.includes("\x1b[38;2;"), "Zig gets the new grammar");
assert.equal(zig?.type === "code" && plain(zig.text), 'const std = @import("std");');
themeName = "light";
const fallback = transform(source, context);
assert(fallback.includes('```typescript\n'));
assert(!fallback.includes("\x1b"), "other themes retain native theme-aware highlighting");
themeName = "gruvbox-dark";
assert.equal(transform(source, context), transformed, "theme selection does not poison either cache");
const document = Array.from({ length: 200 }, (_, i) => `Example ${i}\n\n\`\`\`typescript src/file-${i}.ts\nconst message = "hello";\n\`\`\`\n\n`).join("");
const start = performance.now();
for (let index = 0; index < 20; index++) transform(document, context);
console.error(`Fence-transform benchmark: ${document.length} characters, ${((performance.now() - start) / 20).toFixed(2)} ms per pass`);
console.log("Shiki code blocks, source preservation, native rendering and theme fallback verified");
