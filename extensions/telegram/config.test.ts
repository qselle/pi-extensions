import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TELEGRAM_CONFIG_BYTES,
  defaultTelegramConfigPath,
  loadTelegramConfig,
  readTelegramConfig,
} from "./config.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const OTHER_TOKEN = "987654321:abcdefghijklmnopqrstuvwxyz_ABCDEFGHI";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pi-telegram-config-"));
}

function writeSecure(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

test("keeps environment-only Telegram configuration available", () => {
  expect(readTelegramConfig({})).toEqual({ status: "disabled" });
  expect(readTelegramConfig({
    PI_TELEGRAM_BOT_TOKEN: TOKEN,
    PI_TELEGRAM_CHAT_ID: "123456789",
  })).toEqual({
    status: "enabled",
    config: { botToken: TOKEN, chatId: "123456789", threadId: undefined, details: "summary" },
  });
});

test("validates Telegram configuration without exposing secrets", () => {
  const partial = readTelegramConfig({ PI_TELEGRAM_BOT_TOKEN: TOKEN });
  expect(partial.status).toBe("invalid");
  expect(JSON.stringify(partial)).not.toContain(TOKEN);

  const malformed = readTelegramConfig({
    PI_TELEGRAM_BOT_TOKEN: TOKEN,
    PI_TELEGRAM_CHAT_ID: "not a chat",
  });
  expect(malformed).toEqual({
    status: "invalid",
    message: "The Telegram chat ID must be numeric or an @channel username.",
  });

  expect(readTelegramConfig({
    PI_TELEGRAM_BOT_TOKEN: TOKEN,
    PI_TELEGRAM_CHAT_ID: "-1001234567890",
    PI_TELEGRAM_THREAD_ID: "0",
  }).status).toBe("invalid");
  expect(readTelegramConfig({
    PI_TELEGRAM_BOT_TOKEN: TOKEN,
    PI_TELEGRAM_CHAT_ID: "@valid_channel",
    PI_TELEGRAM_GOAL_DETAILS: "everything",
  }).status).toBe("invalid");
});

test("loads optional thread and detail settings", () => {
  expect(readTelegramConfig({
    PI_TELEGRAM_BOT_TOKEN: TOKEN,
    PI_TELEGRAM_CHAT_ID: "-1001234567890",
    PI_TELEGRAM_THREAD_ID: "42",
    PI_TELEGRAM_GOAL_DETAILS: "full",
  })).toEqual({
    status: "enabled",
    config: {
      botToken: TOKEN,
      chatId: "-1001234567890",
      threadId: 42,
      details: "full",
    },
  });
});

test("resolves the default Pi config path and explicit overrides", () => {
  expect(defaultTelegramConfigPath({}, "/home/test", "/work")).toBe("/home/test/.pi/agent/telegram.json");
  expect(defaultTelegramConfigPath({ PI_CODING_AGENT_DIR: "~/custom-pi" }, "/home/test", "/work"))
    .toBe("/home/test/custom-pi/telegram.json");
  expect(defaultTelegramConfigPath({ PI_TELEGRAM_CONFIG_FILE: "config/telegram.json" }, "/home/test", "/work"))
    .toBe("/work/config/telegram.json");
});

test("loads a secure file and applies per-field environment overrides", () => {
  const directory = temporaryDirectory();
  const path = join(directory, "telegram.json");
  try {
    writeSecure(path, {
      botToken: TOKEN,
      chatId: "111111111",
      threadId: 42,
      details: "full",
    });
    expect(loadTelegramConfig({
      env: {
        PI_TELEGRAM_CHAT_ID: "222222222",
        PI_TELEGRAM_GOAL_DETAILS: "minimal",
      },
      configFile: path,
    })).toEqual({
      status: "enabled",
      config: {
        botToken: TOKEN,
        chatId: "222222222",
        threadId: 42,
        details: "minimal",
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loads the legacy telegram-notify config when the new default is absent", () => {
  const directory = temporaryDirectory();
  try {
    writeSecure(join(directory, "telegram-notify.json"), {
      botToken: TOKEN,
      chatId: "444444444",
    });
    expect(loadTelegramConfig({
      env: { PI_CODING_AGENT_DIR: directory },
    })).toEqual({
      status: "enabled",
      config: { botToken: TOKEN, chatId: "444444444", threadId: undefined, details: "summary" },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("supports an environment-only quick test when the default file is absent", () => {
  const directory = temporaryDirectory();
  try {
    expect(loadTelegramConfig({
      env: {
        PI_CODING_AGENT_DIR: directory,
        PI_TELEGRAM_BOT_TOKEN: OTHER_TOKEN,
        PI_TELEGRAM_CHAT_ID: "333333333",
      },
    })).toEqual({
      status: "enabled",
      config: { botToken: OTHER_TOKEN, chatId: "333333333", threadId: undefined, details: "summary" },
    });
    expect(loadTelegramConfig({
      env: { PI_TELEGRAM_CONFIG_FILE: join(directory, "missing.json") },
    })).toMatchObject({ status: "invalid", message: expect.stringContaining("does not exist") });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects malformed, unknown, oversized, and non-regular config files", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "telegram.json");
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(loadTelegramConfig({ env: {}, configFile: path })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("not valid JSON"),
    });

    writeSecure(path, { botToken: "", chatId: "" });
    expect(loadTelegramConfig({ env: {}, configFile: path })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("require both"),
    });

    writeSecure(path, { botToken: TOKEN, chatId: "1", typo: true });
    expect(loadTelegramConfig({ env: {}, configFile: path })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("unsupported field"),
    });

    writeFileSync(path, "x".repeat(MAX_TELEGRAM_CONFIG_BYTES + 1), { mode: 0o600 });
    expect(loadTelegramConfig({ env: {}, configFile: path })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("at most"),
    });

    const subdirectory = join(directory, "not-a-file");
    mkdirSync(subdirectory);
    expect(loadTelegramConfig({ env: {}, configFile: subdirectory })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("regular file"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects symlinks, broad Unix permissions, and foreign ownership", () => {
  if (process.platform === "win32") return;
  const directory = temporaryDirectory();
  try {
    const target = join(directory, "target.json");
    const link = join(directory, "link.json");
    writeSecure(target, { botToken: TOKEN, chatId: "123456789" });
    symlinkSync(target, link);
    expect(loadTelegramConfig({ env: {}, configFile: link })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("symbolic link"),
    });

    chmodSync(target, 0o644);
    expect(loadTelegramConfig({ env: {}, configFile: target })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("chmod 600"),
    });

    chmodSync(target, 0o600);
    expect(loadTelegramConfig({
      env: {},
      configFile: target,
      currentUid: (process.getuid?.() ?? 0) + 1,
    })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("current user"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
