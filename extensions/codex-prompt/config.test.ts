import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accentColor, parseAccent, readSettings, writeSettings } from "./config.ts";

test("accepts theme/thinking and literal RGB hex only", () => {
  expect(parseAccent(" #AbC ")).toBe("#abc");
  for (const invalid of ["red", "#12345", "#ggg", "\x1b[31m", "#12345678"]) expect(parseAccent(invalid)).toBeUndefined();
  const theme = (text: string) => `[${text}]`;
  expect(accentColor("theme", theme)?.("x")).toBe("[x]");
  expect(accentColor("thinking", theme)).toBeUndefined();
  expect(accentColor("#abc", theme)?.("x")).toBe("\x1b[38;2;170;187;204mx\x1b[39m");
});
test("setting changes preserve other fields and never overwrite malformed JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-prompt-config-"));
  const path = join(root, "config.json");
  try {
    expect(readSettings(path)).toEqual({ enabled: true, accent: "theme" });
    writeFileSync(path, JSON.stringify({ enabled: false, custom: "preserved" }));
    writeSettings(path, { accent: "#abc" });
    writeSettings(path, { enabled: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: true, accent: "#abc", custom: "preserved" });
    writeFileSync(path, "{broken");
    expect(() => writeSettings(path, { enabled: false })).toThrow("Repair");
    expect(readFileSync(path, "utf8")).toBe("{broken");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
