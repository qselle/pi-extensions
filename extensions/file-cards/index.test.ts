import { expect, test } from "bun:test";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fileCards from "./index.ts";

const FG_TOKENS: ThemeColor[] = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
  "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax",
  "bashMode",
];
const theme = new Theme(
  Object.fromEntries(FG_TOKENS.map((token) => [token, "#d0d0d0"])) as Record<ThemeColor, string>,
  {
    selectedBg: "#202020", userMessageBg: "#202020", customMessageBg: "#202020",
    toolPendingBg: "#202020", toolSuccessBg: "#203020", toolErrorBg: "#302020",
  },
  "truecolor",
);

class MockPi {
  tools = new Map<string, any>();
  registerTool(tool: any) { this.tools.set(tool.name, tool); }
}

initTheme("dark", false);

test("overrides only edit and write presentation while preserving native metadata and execution", async () => {
  const pi = new MockPi();
  fileCards(pi as any);

  expect([...pi.tools.keys()]).toEqual(["edit", "write"]);
  for (const tool of pi.tools.values()) {
    expect(tool.renderShell).toBe("self");
    expect(tool.description).toBeString();
    expect(tool.promptSnippet).toBeString();
    expect(tool.promptGuidelines.length).toBeGreaterThan(0);
    expect(tool.parameters.type).toBe("object");
  }
  expect(pi.tools.get("edit").prepareArguments).toBeFunction();

  const directory = await mkdtemp(join(tmpdir(), "pi-file-cards-"));
  try {
    await writeFile(join(directory, "sample.ts"), "export const answer = 41;\n", "utf8");
    const edit = pi.tools.get("edit");
    const editArgs = {
      path: "sample.ts",
      edits: [{ oldText: "answer = 41", newText: "answer = 42" }],
    };
    const editResult = await edit.execute(
      "edit-1",
      editArgs,
      new AbortController().signal,
      undefined,
      { cwd: directory },
    );
    expect(await readFile(join(directory, "sample.ts"), "utf8")).toBe("export const answer = 42;\n");
    expect(editResult.details.diff).toContain("-1 export const answer = 41;");
    expect(editResult.details.diff).toContain("+1 export const answer = 42;");

    const editContext = {
      args: editArgs,
      state: {},
      cwd: directory,
      expanded: false,
      isError: false,
    };
    const editCard = edit.renderCall(editArgs, theme, editContext);
    const emptyResult = edit.renderResult(editResult, { expanded: false, isPartial: false }, theme, editContext);
    const renderedEdit = editCard.render(70).join("\n");
    expect(renderedEdit).toContain("sample.ts");
    expect(renderedEdit).toContain("+1");
    expect(emptyResult.render(70)).toEqual([]);

    const write = pi.tools.get("write");
    const writeArgs = { path: "nested/new.py", content: "def value():\n    return 42\n" };
    const writeResult = await write.execute(
      "write-1",
      writeArgs,
      new AbortController().signal,
      undefined,
      { cwd: directory },
    );
    expect(await readFile(join(directory, "nested/new.py"), "utf8")).toBe(writeArgs.content);
    expect(writeResult.content[0].text).toContain("Successfully wrote");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("result rendering can reconstruct a card when the call component is unavailable", () => {
  const pi = new MockPi();
  fileCards(pi as any);
  const write = pi.tools.get("write");
  const args = { path: "src/generated.ts", content: "export const generated = true;\n" };
  const context = { args, state: {}, expanded: false, isError: false };
  const component = write.renderResult(
    { content: [{ type: "text", text: "Successfully wrote" }] },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  const rendered = component.render(60).join("\n");
  expect(rendered).toContain("WRITE");
  expect(rendered).toContain("generated.ts");
});
