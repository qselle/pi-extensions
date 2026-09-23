import { expect, test } from "bun:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { commandCatalog, searchCommands } from "./catalog.ts";

const command = (name: string, description = "", source: SlashCommandInfo["source"] = "extension", scope = "user"): SlashCommandInfo =>
  ({ name, description, source, sourceInfo: { scope, path: "/not-displayed", origin: "package", source: "local" } } as SlashCommandInfo);

test("catalog keeps first invokable command and removes unsafe names and display controls", () => {
  const items = commandCatalog([command("web", "First\nline\x1b[0m"), command("web", "Shadowed"), command("skill:review", "Review", "skill", "project"),
    command("/wrong"), command("two words"), command("unsafe\x1b"), command("bidi\u202e"), command("")]);
  expect(items.map((item) => item.name)).toEqual(["skill:review", "web"]);
  expect(items[1]!.description).toBe("First line [0m");
  expect(JSON.stringify(items)).not.toContain("/not-displayed");
});

test("name matches outrank descriptions, and descriptions support independent search terms", () => {
  const items = commandCatalog([command("doctor", "Check Telegram configuration"), command("telegram", "Send messages"),
    command("skill:review", "Review changes", "skill", "project"), command("session-search", "Full text search")]);
  expect(searchCommands(items, "telegram").map((item) => item.name)).toEqual(["telegram", "doctor"]);
  expect(searchCommands(items, "/telegram")[0]!.name).toBe("telegram");
  expect(searchCommands(items, "configuration check").map((item) => item.name)).toEqual(["doctor"]);
  expect(searchCommands(items, "project skill").map((item) => item.name)).toEqual(["skill:review"]);
  expect(searchCommands(items, "ssrch")[0]!.name).toBe("session-search");
  expect(searchCommands(items, "zzzzzz")).toEqual([]);
  expect(searchCommands(items, "")).toEqual(items);
});
