import { expect, test } from "bun:test";
import { Lexer } from "marked";
import { stripVTControlCharacters as plain } from "node:util";
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
test("streamed code gets highlighting and a stable caption as soon as its header is complete", () => {
  const source = '````TS x.ts\n```\nbody';
  expect(formatCodeBlocks(source, infer)).toContain("````typescript\n```\nbody");
  expect(code(formatCodeBlocks(source, infer))).toEqual(code(source));
  expect(formatCodeBlocks("````TS x.ts", infer)).toBe("````TS x.ts");
  expect(formatCodeBlocks(source + '\n````', infer)).toContain('````typescript');
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
  expect(format(open)).toContain("```typescript");
  expect(format(open + "\n```").startsWith(format(open))).toBe(true);
});

const highlight = (source: string, language: string) => language === "typescript"
  ? source.split("\n").map((line) => `\x1b[38;2;254;128;25m${line}\x1b[39m`)
  : undefined;

test("display colors survive neutral fences with language and path retained in one caption", () => {
  const source = 'Before\n\n```TS src/app.ts\nconst x = "界";\n\n\tx;\n```\n\nAfter';
  const result = formatCodeBlocks(source, infer, highlight);
  expect(result).toContain('` typescript · src/app.ts `\n\n```\n');
  expect(code(result).map(plain)).toEqual(code(source));
  expect(result.endsWith("After")).toBe(true);
  expect(formatCodeBlocks(result, infer, highlight)).toBe(result);
});

test("highlighting preserves empty, streaming, longer and indented closing fences", () => {
  for (const source of [
    '```ts\n```', '```ts\n\n```', '```ts\nx\n\n```\n', '~~~ts\nx\n~~~~\n',
    '```ts\nx\n  ``` \n', '````ts\n```\nx\n`````', '```ts\nx', '```ts\nx\n\n',
  ]) {
    const result = formatCodeBlocks(source, infer, highlight);
    expect(code(result).map(plain)).toEqual(code(source));
    expect(formatCodeBlocks(result, infer, highlight)).toBe(result);
  }
});

test("unsupported and indentation-sensitive blocks retain the native path", () => {
  for (const source of ['```rust src/main.rs\nfn main() {}\n```', '  ```ts src/app.ts\n  const x = 1;\n  ```', '```ts\r\nx\r\n```']) {
    expect(formatCodeBlocks(source, infer, highlight)).toBe(formatCodeBlocks(source, infer));
  }
  expect(formatCodeBlocks('```ts\nx\n```', infer, () => undefined)).toBe('```typescript\nx\n```');
});
