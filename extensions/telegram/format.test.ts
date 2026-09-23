import { expect, test } from "bun:test";
import { formatTelegramMessage } from "./format.ts";

test("direct notifications format readable headings, lists, code, links and quotes", () => {
  expect(formatTelegramMessage("# Done\n\n**42 files**, *reviewed*, ~~old~~ and `code`\n\n- [x] Build\n- [ ] Ship\n\n> review\n\n[report](https://example.com?a=1&b=2)")).toBe([
    "<b>Done</b>",
    "<b>42 files</b>, <i>reviewed</i>, <s>old</s> and <code>code</code>",
    "☑ Build\n☐ Ship",
    "│ review",
    '<a href="https://example.com/?a=1&amp;b=2">report</a>',
  ].join("\n\n"));
  expect(formatTelegramMessage("```ts\nconst x = 1 < 2;\n```\n\n3. Three\n4. Four")).toBe('<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>\n\n3. Three\n4. Four');
  expect(formatTelegramMessage("one\ntwo")).toBe("one\ntwo");
});

test("raw HTML, terminal controls, images and unsafe links cannot add active content", () => {
  const html = formatTelegramMessage('<b>Raw</b> & more\n\n[click](javascript:alert%281%29) [local](file:///etc/passwd) [credentials](https://user:pass@example.com)\n\n![image](https://example.com/image.png)\n\n\u001b[31mRed\u001b[0m\u001b]8;;https://evil.example\u0007text\u001b]8;;\u0007');
  expect(html).toContain("&lt;b&gt;Raw&lt;/b&gt; &amp; more");
  expect(html).toContain("click local credentials");
  expect(html).toContain("image");
  expect(html).toContain("Redtext");
  expect(html).not.toContain("<a");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("\u001b");
  expect(html).not.toContain("https://example.com/image.png");
});

test("nested code avoids Telegram entity restrictions and tables stay readable", () => {
  expect(formatTelegramMessage("**Use `code`** and [the `link`](https://example.com)")).toBe('<b>Use code</b> and <a href="https://example.com/">the link</a>');
  const table = "| Name | State |\n| --- | --- |\n| Build | Done |";
  expect(formatTelegramMessage(table)).toBe(`<pre>${table}</pre>`);
});

test("validate visible length before sending without cutting markup or Unicode", () => {
  expect(formatTelegramMessage(`**${"a".repeat(4096)}**`)).toBe(`<b>${"a".repeat(4096)}</b>`);
  expect(formatTelegramMessage("&".repeat(4096))).toBe("&amp;".repeat(4096));
  expect(formatTelegramMessage("🙂".repeat(2048))).toBe("🙂".repeat(2048));
  expect(() => formatTelegramMessage("🙂".repeat(2049))).toThrow("4096");
  expect(() => formatTelegramMessage("a".repeat(4097))).toThrow("4096");
  expect(() => formatTelegramMessage("a".repeat(16385))).toThrow("16384");
  expect(() => formatTelegramMessage(" \n\t ")).toThrow("must contain text");
});
