import assert from "node:assert/strict";
import { stripVTControlCharacters as plain } from "node:util";
import { disposeSyntax, highlightSyntax, initializeSyntax, supportsSyntaxLanguage, SYNTAX_MAX_CODE_LENGTH } from "./syntax.ts";

assert.equal(highlightSyntax("const x = 1", "typescript"), undefined);
assert.equal(supportsSyntaxLanguage("typescript"), false);
const started = performance.now();
const initialization = initializeSyntax();
assert.equal(initializeSyntax(), initialization, "concurrent initialization shares one promise");
assert.equal(await initialization, true);
const coldMs = performance.now() - started;

const examples: Record<string, string> = {
  typescript: 'const greeting: string = "hello"; // a comment\n\tconsole.log(greeting);\n\n',
  tsx: 'export const View = () => <button disabled={false}>hello</button>;',
  javascript: 'const greeting = "hello"; console.log(greeting);',
  jsx: 'const View = () => <span>hello</span>;',
  bash: 'if true; then\n\tprintf "%s\\n" "$PWD" # directory\nfi\n',
  python: 'def hello(name: str):\n\treturn f"hello {name}"\n',
  json: '{ "enabled": true, "value": 42 }',
  yaml: 'enabled: true\nvalue: 42',
  toml: '[section]\nenabled = true',
  html: '<div class="title">hello</div>',
  css: '.title { color: red; }',
  sql: 'SELECT id FROM users WHERE active = TRUE;',
  rust: 'fn main() { let message = "hello"; println!("{message}"); }',
  go: 'package main\nfunc main() { println("hello") }',
  c: '#include <stdio.h>\nint main() { return 0; }',
  cpp: '#include <string>\nstd::string message = "hello";',
  zig: 'const std = @import("std");\npub fn main() void {}',
  diff: '-old\n+new\n context\n',
};
for (const [lang, code] of Object.entries(examples)) {
  assert(supportsSyntaxLanguage(lang), `${lang} must be loaded`);
  const rows = highlightSyntax(code, lang);
  assert(rows, `${lang} must highlight`);
  assert.equal(plain(rows.join("\n")), code, `${lang} source must stay exact`);
  assert.equal(rows.length, code.split("\n").length);
  assert(rows.every((line) => line.startsWith("\x1b[22;23;24;29;39m") && line.endsWith("\x1b[22;23;24;29;39m")));
  assert(!rows.join("").match(/\x1b\[(?:0|4[089]|10[0-7])(?:;|m)/), "no full reset or background escape");
}
const colors = new Set(highlightSyntax(examples.typescript!, "typescript")!.join("").match(/\x1b\[38;2;[^m]+m/g));
assert(colors.size >= 4, "tokens need distinct syntax colors");
assert.deepEqual(highlightSyntax(examples.typescript!, " TS "), highlightSyntax(examples.typescript!, "typescript"));
assert.deepEqual(highlightSyntax(examples.bash!, "shell"), highlightSyntax(examples.bash!, "bash"));
assert.deepEqual(highlightSyntax(examples.cpp!, "c++"), highlightSyntax(examples.cpp!, "cpp"));
assert.equal(plain(highlightSyntax("", "typescript")!.join("\n")), "");
for (const partial of ['const value = "still streaming', '/* unfinished comment\nmore', 'const emoji = "🌿 café 中文";\n']) {
  assert.equal(plain(highlightSyntax(partial, "typescript")!.join("\n")), partial);
}
assert(highlightSyntax("// a comment", "typescript")!.join("").includes(";3m"), "theme font styles survive token conversion");
assert.equal(highlightSyntax("anything", "unknown-language"), undefined);
assert.equal(highlightSyntax("anything", ""), undefined);
for (const unsafe of ["a\x1b[31mb", "a\x00b", "a\rb", "a\r\nb", "a\x9bb"]) assert.equal(highlightSyntax(unsafe, "typescript"), undefined);
assert.equal(highlightSyntax("x".repeat(SYNTAX_MAX_CODE_LENGTH + 1), "typescript"), undefined);
assert.equal(highlightSyntax("x".repeat(4096), "typescript"), undefined);
assert.equal(highlightSyntax("\n".repeat(2000), "typescript"), undefined);

const original = highlightSyntax(examples.typescript!, "typescript")!;
original[0] = "tampered";
assert.notEqual(highlightSyntax(examples.typescript!, "typescript")![0], "tampered", "cache results are not mutable by callers");
for (let index = 0; index < 40; index++) highlightSyntax(`const value${index} = ${index};`, "typescript");
assert.equal(plain(highlightSyntax(examples.typescript!, "typescript")!.join("\n")), examples.typescript);

const block = Array.from({ length: 100 }, (_, index) => `const value${index}: string = "hello"; // stable line`).join("\n");
const first = performance.now();
assert(highlightSyntax(block, "typescript"));
const firstMs = performance.now() - first;
const warm = performance.now();
for (let index = 0; index < 100; index++) assert(highlightSyntax(block, "typescript"));
const warmMs = (performance.now() - warm) / 100;
console.error(`Shiki: init ${coldMs.toFixed(1)}ms; first ${block.length}-char block ${firstMs.toFixed(2)}ms; cached ${warmMs.toFixed(3)}ms/pass`);

disposeSyntax();
disposeSyntax();
assert.equal(supportsSyntaxLanguage("typescript"), false, "disposal clears language availability");
assert.equal(highlightSyntax(block, "typescript"), undefined, "disposed cache is unavailable");
const abandoned = initializeSyntax();
disposeSyntax();
assert.equal(await abandoned, false, "an instance created after disposal must be discarded");
assert.equal(supportsSyntaxLanguage("typescript"), false, "late initialization cannot repopulate disposed state");
assert.equal(highlightSyntax(block, "typescript"), undefined);

const stale = initializeSyntax();
disposeSyntax();
const current = initializeSyntax();
assert.notEqual(current, stale, "reinitialization creates a fresh promise");
assert.equal(await current, true);
assert.equal(await stale, false, "an older generation cannot become ready");
assert.equal(initializeSyntax(), current, "an older generation cannot replace the current initialization");
assert(supportsSyntaxLanguage("typescript"));
assert.equal(plain(highlightSyntax(block, "typescript")!.join("\n")), block, "new generation remains usable");
disposeSyntax();
assert.equal(await initializeSyntax(), true, "ordinary reload can initialize again");
assert.equal(plain(highlightSyntax(examples.bash!, "bash")!.join("\n")), examples.bash);
disposeSyntax();
console.log("Native Shiki source, styles, aliases, cache and fallback verified");
