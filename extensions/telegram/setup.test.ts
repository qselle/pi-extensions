import { expect, test } from "bun:test";
import { promptTelegramSetup } from "./setup.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const theme = { fg: (_color: string, value: string) => value };

test("masks the bot token and returns validated setup values", async () => {
  let rendered = "";
  const inputs = ["987654321", "0.25"];
  const ctx = {
    mode: "tui",
    ui: {
      notify: () => undefined,
      input: async () => inputs.shift(),
      custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
        const component = factory({ requestRender: () => undefined }, theme, {}, resolve) as any;
        component.focused = true;
        component.input.setValue(TOKEN);
        rendered = component.render(100).join("\n");
        component.input.onSubmit(TOKEN);
      }),
    },
  } as any;

  expect(await promptTelegramSetup(ctx)).toEqual({
    botToken: TOKEN,
    chatId: "987654321",
    threadId: undefined,
    details: "summary",
    questionDelayMinutes: 0.25,
  });
  expect(rendered).not.toContain(TOKEN);
  expect(rendered).toContain("•".repeat(12));
});

test("rejects invalid setup without exposing the token", async () => {
  const notifications: string[] = [];
  const inputs = ["987654321", "0"];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => TOKEN,
      input: async () => inputs.shift(),
      notify: (message: string) => notifications.push(message),
    },
  } as any;

  expect(await promptTelegramSetup(ctx)).toBeUndefined();
  expect(notifications.join(" ")).toContain("greater than 0");
  expect(notifications.join(" ")).not.toContain(TOKEN);
});
