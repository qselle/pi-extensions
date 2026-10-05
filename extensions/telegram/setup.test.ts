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

test("group setup asks for the one user allowed to answer", async () => {
  const prompts: string[] = [];
  const inputs = ["-1001234567890", "424242", "5"];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => TOKEN,
      input: async (label: string) => { prompts.push(label); return inputs.shift(); },
      notify: () => undefined,
    },
  } as any;
  expect(await promptTelegramSetup(ctx)).toMatchObject({ chatId: "-1001234567890", answerUserId: "424242" });
  expect(prompts[1]).toContain("only this user can answer");

  const invalid = ["-1001234567890", "not-a-user", "5"];
  const notifications: string[] = [];
  ctx.ui.input = async () => invalid.shift();
  ctx.ui.notify = (message: string) => notifications.push(message);
  expect(await promptTelegramSetup(ctx)).toBeUndefined();
  expect(notifications.join(" ")).toContain("answer user ID");
});
