import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type TelegramGoalDetails = "minimal" | "summary" | "full";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  threadId?: number;
  details: TelegramGoalDetails;
}

export interface TelegramConfigFile {
  botToken?: string;
  chatId?: string;
  threadId?: number;
  details?: TelegramGoalDetails;
}

export type TelegramConfigResult =
  | { status: "enabled"; config: TelegramConfig }
  | { status: "disabled" }
  | { status: "invalid"; message: string };

export interface LoadTelegramConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  configFile?: string | false;
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  currentUid?: number;
}

export const TELEGRAM_CONFIG_FILENAME = "telegram-notify.json";
export const MAX_TELEGRAM_CONFIG_BYTES = 64 * 1024;

const CONFIG_KEYS = new Set(["botToken", "chatId", "threadId", "details"]);

export function defaultTelegramConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir = homedir(),
  cwd = process.cwd(),
): string {
  const explicit = env.PI_TELEGRAM_CONFIG_FILE?.trim();
  if (explicit) return resolveUserPath(explicit, homeDir, cwd);
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  const directory = agentDir
    ? resolveUserPath(agentDir, homeDir, cwd)
    : join(homeDir, ".pi", "agent");
  return join(directory, TELEGRAM_CONFIG_FILENAME);
}

export function loadTelegramConfig(options: LoadTelegramConfigOptions = {}): TelegramConfigResult {
  const env = options.env ?? process.env;
  if (options.configFile === false) return readTelegramConfig(env);
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const explicitPath = typeof options.configFile === "string"
    ? options.configFile
    : env.PI_TELEGRAM_CONFIG_FILE?.trim();
  const path = typeof options.configFile === "string"
    ? resolveUserPath(options.configFile, homeDir, cwd)
    : defaultTelegramConfigPath(env, homeDir, cwd);
  const file = readSecureConfigFile(path, {
    required: Boolean(explicitPath),
    platform: options.platform ?? process.platform,
    currentUid: options.currentUid ?? process.getuid?.(),
  });
  if (file.status === "missing") return readTelegramConfig(env);
  if (file.status === "invalid") return file;
  const parsed = parseTelegramConfigFile(file.content, path);
  if (parsed.status === "invalid") return parsed;
  return readTelegramConfig(env, parsed.config);
}

export function readTelegramConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  file: TelegramConfigFile = {},
): TelegramConfigResult {
  const botToken = env.PI_TELEGRAM_BOT_TOKEN?.trim() || file.botToken?.trim();
  const chatId = env.PI_TELEGRAM_CHAT_ID?.trim() || file.chatId?.trim();
  const envThreadId = env.PI_TELEGRAM_THREAD_ID?.trim();
  const rawThreadId: string | number | undefined = envThreadId || file.threadId;
  const details = env.PI_TELEGRAM_GOAL_DETAILS?.trim() || file.details || "summary";

  const configured = Object.keys(file).length > 0
    || Boolean(botToken || chatId || rawThreadId !== undefined || env.PI_TELEGRAM_GOAL_DETAILS?.trim());
  if (!configured) return { status: "disabled" };
  if (!botToken || !chatId) {
    return { status: "invalid", message: "Telegram notifications require both botToken/chatId in the config file or PI_TELEGRAM_BOT_TOKEN/PI_TELEGRAM_CHAT_ID." };
  }
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,64}$/.test(botToken)) {
    return { status: "invalid", message: "The Telegram bot token does not have a valid bot-token format." };
  }
  if (!/^-?\d+$/.test(chatId) && !/^@[A-Za-z0-9_]{5,32}$/.test(chatId)) {
    return { status: "invalid", message: "The Telegram chat ID must be numeric or an @channel username." };
  }

  let threadId: number | undefined;
  if (rawThreadId !== undefined) {
    threadId = typeof rawThreadId === "number" ? rawThreadId : Number(rawThreadId);
    if (!Number.isSafeInteger(threadId) || threadId <= 0) {
      return { status: "invalid", message: "The Telegram thread ID must be a positive integer." };
    }
  }
  if (details !== "minimal" && details !== "summary" && details !== "full") {
    return { status: "invalid", message: "Telegram goal details must be minimal, summary, or full." };
  }

  return {
    status: "enabled",
    config: { botToken, chatId, threadId, details },
  };
}

function parseTelegramConfigFile(
  content: string,
  path: string,
): { status: "valid"; config: TelegramConfigFile } | { status: "invalid"; message: string } {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return invalidFile(path, "is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidFile(path, "must contain one JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) return invalidFile(path, `contains unsupported field ${JSON.stringify(unknown[0])}`);
  if (Object.keys(record).length === 0) return invalidFile(path, "must define at least one Telegram setting");
  if (record.botToken !== undefined && typeof record.botToken !== "string") return invalidFile(path, "field botToken must be a string");
  if (record.chatId !== undefined && typeof record.chatId !== "string" && typeof record.chatId !== "number") {
    return invalidFile(path, "field chatId must be a string or integer");
  }
  if (typeof record.chatId === "number" && !Number.isSafeInteger(record.chatId)) return invalidFile(path, "field chatId must be a safe integer");
  if (record.threadId !== undefined && (!Number.isSafeInteger(record.threadId) || (record.threadId as number) <= 0)) {
    return invalidFile(path, "field threadId must be a positive integer");
  }
  if (record.details !== undefined && record.details !== "minimal" && record.details !== "summary" && record.details !== "full") {
    return invalidFile(path, "field details must be minimal, summary, or full");
  }
  return {
    status: "valid",
    config: {
      botToken: record.botToken as string | undefined,
      chatId: record.chatId === undefined ? undefined : String(record.chatId),
      threadId: record.threadId as number | undefined,
      details: record.details as TelegramGoalDetails | undefined,
    },
  };
}

function readSecureConfigFile(
  path: string,
  options: { required: boolean; platform: NodeJS.Platform; currentUid?: number },
): { status: "valid"; content: string } | { status: "missing" } | { status: "invalid"; message: string } {
  try {
    const linkStats = lstatSync(path);
    if (linkStats.isSymbolicLink()) return invalidFile(path, "must not be a symbolic link");
    if (!linkStats.isFile()) return invalidFile(path, "must be a regular file");
  } catch (error) {
    if (isFileError(error, "ENOENT")) {
      return options.required ? invalidFile(path, "does not exist") : { status: "missing" };
    }
    return invalidFile(path, "cannot be inspected");
  }

  let descriptor: number | undefined;
  try {
    const noFollow = options.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return invalidFile(path, "must be a regular file");
    if (stats.size > MAX_TELEGRAM_CONFIG_BYTES) {
      return invalidFile(path, `must be at most ${MAX_TELEGRAM_CONFIG_BYTES} bytes`);
    }
    if (options.platform !== "win32") {
      if ((stats.mode & 0o077) !== 0) return invalidFile(path, "must use owner-only permissions (run chmod 600)");
      if (options.currentUid !== undefined && stats.uid !== options.currentUid) {
        return invalidFile(path, "must be owned by the current user");
      }
    }
    return { status: "valid", content: readFileSync(descriptor, "utf8") };
  } catch {
    return invalidFile(path, "cannot be read safely");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolveUserPath(value: string, homeDir: string, cwd: string): string {
  const expanded = value === "~"
    ? homeDir
    : value.startsWith("~/") || value.startsWith("~\\")
      ? join(homeDir, value.slice(2))
      : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function invalidFile(path: string, reason: string): { status: "invalid"; message: string } {
  return { status: "invalid", message: `Telegram config file ${JSON.stringify(path)} ${reason}.` };
}

function isFileError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code);
}
