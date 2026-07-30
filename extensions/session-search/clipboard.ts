import { spawn } from "node:child_process";

export interface ClipboardCommand {
  command: string;
  args: string[];
}

export type ClipboardRunner = (candidate: ClipboardCommand, text: string) => Promise<boolean>;

export function clipboardCommands(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
  if (environment.TERMUX_VERSION) return [{ command: "termux-clipboard-set", args: [] }];
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip.exe", args: [] }];
  if (platform === "linux") {
    return [
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    ];
  }
  return [];
}

export async function copyText(
  text: string,
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    runner?: ClipboardRunner;
  } = {},
): Promise<boolean> {
  const runner = options.runner ?? runClipboardCommand;
  for (const candidate of clipboardCommands(options.platform, options.environment)) {
    if (await runner(candidate, text)) return true;
  }
  return false;
}

async function runClipboardCommand(candidate: ClipboardCommand, text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const child = spawn(candidate.command, candidate.args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 3_000);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(text);
  });
}
