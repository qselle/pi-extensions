import assert from "node:assert/strict";
import { initTheme, getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import extension from "./index.ts";
initTheme("dark", false);
let transform: any;
extension({ registerMarkdownTransformer: (callback: any) => { transform = callback; } } as never);
const source = '```typescript src/app.ts\nconst message = "hello";\n```';
const context = { messageType: "assistant", availableWidth: 80, isStreaming: false };
const transformed = transform(source, context);
assert(transformed.includes('```typescript\n'));
assert.equal(transform(source, { ...context, messageType: "user" }), source);
assert.equal(transform(source, { ...context, messageType: "assistant-thinking" }), source);
const component = new Markdown(source, 0, 0, getMarkdownTheme(), undefined, { transform: (text, width) => transform(text, { ...context, availableWidth: width }) });
for (const width of [1, 20, 80]) {
  const rendered = component.render(width);
  assert(rendered.every((line) => visibleWidth(line) <= width));
  if (width === 80) {
    assert(rendered.join("\n").includes("src/app.ts"));
    assert(rendered.join("\n").includes(highlightCode('const message = "hello";', "typescript")[0]!));
  }
}
const document = Array.from({ length: 200 }, (_, i) => `Example ${i}\n\n\`\`\`typescript src/file-${i}.ts\nconst message = "hello";\n\`\`\`\n\n`).join("");
const start = performance.now();
for (let index = 0; index < 20; index++) transform(document, context);
console.error(`Fence-transform benchmark: ${document.length} characters, ${((performance.now() - start) / 20).toFixed(2)} ms per pass`);
console.log("code block captions and native highlighting verified");
