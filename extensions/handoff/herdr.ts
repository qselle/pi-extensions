import { basename } from "node:path";

export type Destination = "pane-right" | "pane-down" | "tab" | "workspace";

export const DESTINATIONS: ReadonlyArray<readonly [label: string, destination: Destination]> = [
  ["New pane to the right", "pane-right"],
  ["New pane below", "pane-down"],
  ["New tab", "tab"],
  ["New workspace", "workspace"],
];

export interface ExecResult { stdout: string; stderr: string; code: number | null }
export type Exec = (command: string, args: string[], options?: { timeout?: number }) => Promise<ExecResult>;

const HERDR_TIMEOUT_MS = 5_000;
/** How long Herdr may wait for the new Pi to be ready for input. */
const PI_READY_TIMEOUT_MS = 30_000;
/** How long a new pane's shell may take to reach its prompt. */
const SHELL_READY_TIMEOUT_MS = 10_000;
const SHELL_RETRY_MS = 150;

export interface Opened {
  paneId: string;
  place: string;
  /** Herdr command that removes everything this destination created. */
  close: string[];
}

export class HerdrError extends Error {
  constructor(readonly operation: string, readonly code: string | undefined, message: string) {
    super(`Herdr ${operation} failed: ${message}`);
  }
}

export function insideHerdr(env: NodeJS.ProcessEnv): boolean {
  return env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID);
}

/**
 * Herdr agent names are unique among live agents: a lowercase letter, then
 * lowercase letters, digits, '-' or '_'. Session IDs start with a timestamp,
 * so the name uses their random end.
 */
export function agentName(sessionFile: string): string {
  const id = basename(sessionFile, ".jsonl").split("_").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8);
  return id ? `handoff-${id}` : "handoff";
}

/** Herdr CLI calls for opening a destination and starting Pi in it. */
export function herdrClient(exec: Exec, env: NodeJS.ProcessEnv, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
  // Herdr exports its own binary to panes; PATH may differ from the shell's.
  const herdr = env.HERDR_BIN_PATH || "herdr";

  const run = async (args: string[], timeout = HERDR_TIMEOUT_MS): Promise<string> => {
    const result = await exec(herdr, args, { timeout });
    if (result.code === 0) return result.stdout;
    const operation = args.slice(0, 2).join(" ");
    let code: string | undefined;
    let message = (result.stderr || result.stdout || `exit code ${result.code ?? "unknown"}`).trim();
    // Herdr reports errors as JSON on stderr.
    for (const output of [result.stderr, result.stdout]) {
      try {
        const error = JSON.parse(output)?.error;
        if (typeof error?.message === "string") message = error.message;
        if (typeof error?.code === "string") code = error.code;
        break;
      } catch {
        // Not JSON; try the other stream or keep the plain text.
      }
    }
    throw new HerdrError(operation, code, message.slice(0, 500));
  };

  const create = async (args: string[]): Promise<any> => {
    const output = await run(args);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`Herdr ${args.slice(0, 2).join(" ")} returned invalid JSON.`);
    }
  };

  return {
    /** Create the destination and return its new shell pane. */
    async open(destination: Destination, cwd: string, label: string): Promise<Opened> {
      let paneId: unknown;
      let place: string;
      let close: string[];
      if (destination === "pane-right" || destination === "pane-down") {
        const direction = destination === "pane-right" ? "right" : "down";
        const payload = await create(["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--focus"]);
        paneId = payload?.result?.pane?.pane_id;
        place = `new pane ${paneId}`;
        close = ["pane", "close", String(paneId)];
      } else if (destination === "tab") {
        const workspace = env.HERDR_WORKSPACE_ID ? ["--workspace", env.HERDR_WORKSPACE_ID] : [];
        const payload = await create(["tab", "create", ...workspace, "--cwd", cwd, "--label", label, "--focus"]);
        const tabId = payload?.result?.tab?.tab_id;
        paneId = payload?.result?.root_pane?.pane_id;
        place = `new tab ${tabId ?? paneId}`;
        close = typeof tabId === "string" ? ["tab", "close", tabId] : ["pane", "close", String(paneId)];
      } else {
        const payload = await create(["workspace", "create", "--cwd", cwd, "--focus"]);
        const workspace = payload?.result?.workspace;
        paneId = payload?.result?.root_pane?.pane_id;
        place = `new workspace ${workspace?.label ?? workspace?.workspace_id ?? paneId}`;
        close = typeof workspace?.workspace_id === "string" ? ["workspace", "close", workspace.workspace_id] : ["pane", "close", String(paneId)];
      }
      if (typeof paneId !== "string" || !paneId) {
        if (close[0] !== "pane") await run(close).catch(() => undefined);
        throw new Error(`Herdr did not return a pane for the ${destination.replace("-", " ")}.`);
      }
      return { paneId, place, close };
    },

    /** Start Pi through Herdr, which passes arguments without shell quoting and waits until Pi is ready. */
    async startPi(paneId: string, name: string, args: string[]): Promise<void> {
      const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
      for (;;) {
        try {
          await run(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", String(PI_READY_TIMEOUT_MS), "--", ...args], PI_READY_TIMEOUT_MS + HERDR_TIMEOUT_MS);
          return;
        } catch (error) {
          // A new pane is busy until its shell reaches the prompt.
          if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy" || Date.now() > deadline) throw error;
          await sleep(SHELL_RETRY_MS);
        }
      }
    },

    /** Whether the destination is confirmed gone. */
    close(opened: Opened): Promise<boolean> {
      return run(opened.close).then(() => true, () => false);
    },
  };
}
