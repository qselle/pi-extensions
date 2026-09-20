import { expect, test } from "bun:test";
import { Lexer } from "marked";
import { formatCodeBlocks, createCodeBlockFormatter, MAX_MARKDOWN_LENGTH } from "./format.ts";
const infer = (path: string) => path.endsWith(".ts") ? "typescript" : undefined;
const code = (text: string) => new Lexer().lex(text).filter((token) => token.type === "code").map((token) => "text" in token ? token.text : "");

test("named code fences retain exact bodies and restore language recognition", () => {
  const source = 'Before\n\n```TS src/app.ts\nconst x = "界";\n\n  x;\n```\n\nAfter';
  const result = formatCodeBlocks(source, infer);
  expect(result).toContain('` src/app.ts `\n\n```typescript\n');
  expect(code(result)).toEqual(code(source));
  expect(result.endsWith("After")).toBe(true);
  expect(formatCodeBlocks(result, infer)).toBe(result);
});
test("path-only fences and aliases use accurate language names", () => {
  expect(formatCodeBlocks('~~~src/app.ts\nx\n~~~', infer)).toContain('~~~typescript\n');
  expect(formatCodeBlocks('```C++\nx\n```', infer)).toBe('```cpp\nx\n```');
  expect(formatCodeBlocks('```unknown.file\nx\n```', infer)).toBe('```unknown.file\nx\n```');
  expect(formatCodeBlocks('```zig\nx\n```', infer)).toBe('```zig\nx\n```');
});
test("literal and nested fences are not rewritten", () => {
  for (const source of ['    ```TS x.ts\n    example\n    ```', '> ```TS x.ts\n> x\n> ```', '- Example\n\n  ```TS x.ts\n  x\n  ```', '<pre>\n```TS x.ts\nx\n```\n</pre>', '```TS x.ts\r\nx\r\n```']) expect(formatCodeBlocks(source, infer)).toBe(source);
});
test("streamed open fences wait for matching closure", () => {
  const source = '````TS x.ts\n```\nbody';
  expect(formatCodeBlocks(source, infer, true)).toBe(source);
  expect(formatCodeBlocks(source + '\n````', infer, true)).toContain('````typescript');
});
test("caption markup and controls cannot become links or formatting", () => {
  const source = '~~~ts [click](https://example.com) `name` \x1b[31m\nconst x=1;\n~~~';
  const result = formatCodeBlocks(source, infer);
  expect(result).toContain('`` [click](https://example.com) `name`');
  expect(result).not.toContain('\x1b');
  expect(code(result)).toEqual(code(source));
});
test("large documents bypass work without dropping code", () => {
  const source = '```TS a.ts\n' + 'x'.repeat(MAX_MARKDOWN_LENGTH) + '\n```';
  expect(formatCodeBlocks(source, infer)).toBe(source);
});

test("bounded cache reuses unchanged content and evicts older source", () => {
  let calls = 0;
  const format = createCodeBlockFormatter((path) => { calls++; return infer(path); });
  const source = "```src/app.ts\nx\n```";
  format(source); format(source);
  expect(calls).toBe(1);
  for (let i = 0; i < 9; i++) format(`\`\`\`src/file-${i}.ts\nx\n\`\`\``);
  format(source);
  expect(calls).toBe(11);
  const open = "```src/app.ts\nx";
  expect(format(open, true)).toBe(open);
  expect(format(open, false)).toContain("```typescript");
});
