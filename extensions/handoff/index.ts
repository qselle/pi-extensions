import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentName, DESTINATIONS, herdrClient, insideHerdr, type Destination, type Exec, type Opened } from "./herdr.ts";
import { createHandoffSession, removeQuietly, seedSession, START_PROMPT, type Handoff } from "./session.ts";

export const CURRENT_PANE = "Current pane";
const REQUEST_MESSAGE = "handoff-request";
const SUMMARY_GUIDE = "Make the summary self-contained: objective and constraints, decisions with reasons, relevant files, exact commands and verification evidence, current state, open questions, and next steps. Separate verified facts from assumptions. Never include secrets.";

type Target = "current" | Destination;

/** A /handoff run waiting for the model's summary. */
interface Request {
  target: Target;
  task?: string;
  handled: boolean;
  summary?: string;
}

interface Dependencies {
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
}

function requestText(task: string | undefined): string {
  return task
    ? `Hand off this task to a new Pi session: ${task}\n\nCall the handoff tool once with a summary focused on that task, then stop.`
    : "Hand off this session's work to a new Pi session. Call the handoff tool once with a summary, then stop.";
}

function result(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export default function handoffExtension(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
  const env = dependencies.env ?? process.env;
  const herdr = herdrClient(dependencies.exec ?? ((command, args, options) => pi.exec(command, args, options)), env, dependencies.sleep);
  let request: Request | undefined;
  pi.on("session_shutdown", () => { request = undefined; });

  /** Write the new session and start Pi on it in a Herdr destination. */
  const launch = async (destination: Destination, handoff: Handoff, ctx: ExtensionContext) => {
    const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
    const sessionFile = createHandoffSession(ctx.cwd, ctx.sessionManager.getSessionDir(), handoff, { model, thinkingLevel: pi.getThinkingLevel() });
    let opened: Opened | undefined;
    try {
      const label = handoff.task?.replace(/\s+/g, " ").slice(0, 40) || pi.getSessionName()?.trim() || "handoff";
      opened = await herdr.open(destination, ctx.cwd, label);
      await herdr.startPi(opened.paneId, agentName(sessionFile), ["--session", sessionFile, ...(handoff.task ? [START_PROMPT] : [])]);
      return { sessionFile, place: opened.place };
    } catch (error) {
      // Pi may have started after Herdr stopped waiting; keep its session unless its pane is gone.
      if (!opened || await herdr.close(opened)) removeQuietly(sessionFile);
      throw error;
    }
  };

  pi.registerTool({
    name: "handoff",
    label: "Hand off",
    description: `Hand off work to a new Pi session that starts from your summary instead of this conversation's history. Use only when the user asks to hand off or move work to a new session, or when /handoff requests it. ${SUMMARY_GUIDE} Afterwards the new session owns the work: do not continue it here unless the user asks.`,
    promptSnippet: "Hand off work to a new Pi session that starts from your summary.",
    promptGuidelines: ["Use handoff only when the user asks to hand off or move work to a new session."],
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 20_000, description: "Self-contained context for the new session." }),
      task: Type.Optional(Type.String({ maxLength: 2_000, description: "What the new session should do. Omit to hand off all of this session's work." })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const current = request && !request.handled ? request : undefined;
      // A /handoff run fixes the task and destination; a direct request asks for a destination.
      const task = current ? current.task : params.task?.trim() || undefined;
      let target = current?.target;
      if (!target) {
        if (!insideHerdr(env) || !ctx.hasUI) {
          throw new Error("A new session can open from here only in Herdr. Ask the user to run /handoff, which can switch this pane to the new session.");
        }
        const choice = await ctx.ui.select("Hand off to", DESTINATIONS.map(([label]) => label));
        target = DESTINATIONS.find(([label]) => label === choice)?.[1];
        if (!target) return result("The user cancelled the handoff. Nothing was handed off.");
      }
      if (current) current.handled = true;
      const work = task ? `"${task}"` : "this session's work";
      if (target === "current") {
        current!.summary = params.summary;
        return result(`Handoff summary saved. When this turn ends, this pane switches to a new session that owns ${work}. Stop now.`);
      }
      const { sessionFile, place } = await launch(target, { summary: params.summary, task, parentSession: ctx.sessionManager.getSessionFile() }, ctx);
      ctx.ui.notify(`Handed off to ${place}.`, "info");
      return result(`Handed off ${work} to a new session in ${place} (${sessionFile}). That session owns it now: do not work on it here unless the user asks.`);
    },
  });

  pi.registerCommand("handoff", {
    description: "Hand off this session's work, or a task, to a new session that starts from a summary: /handoff [task]",
    async handler(args, ctx) {
      const task = args.trim() || undefined;
      if (request) { ctx.ui.notify("A handoff is already in progress.", "warning"); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Finish or cancel the current run and queued messages before handing off.", "warning"); return; }
      if (!ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) { ctx.ui.notify("Nothing to hand off yet.", "info"); return; }
      if (!ctx.model) { ctx.ui.notify("Select a model first: it writes the handoff summary.", "warning"); return; }

      let target: Target = "current";
      if (insideHerdr(env) && ctx.hasUI) {
        const choice = await ctx.ui.select(task ? "Hand off task to" : "Hand off to", [CURRENT_PANE, ...DESTINATIONS.map(([label]) => label)]);
        if (choice === undefined) return;
        target = DESTINATIONS.find(([label]) => label === choice)?.[1] ?? "current";
      }

      const current: Request = { target, task, handled: false };
      request = current;
      try {
        // The current model writes the summary through the tool, reusing its cached context.
        pi.sendMessage({ customType: REQUEST_MESSAGE, content: requestText(task), display: true }, { triggerTurn: true });
        await ctx.waitForIdle();
        if (!current.handled) { ctx.ui.notify("Nothing was handed off: the model did not call the handoff tool.", "warning"); return; }
        if (target !== "current" || current.summary === undefined) return;

        const handoff: Handoff = { summary: current.summary, task, parentSession: ctx.sessionManager.getSessionFile() };
        const outcome = await ctx.newSession({
          parentSession: handoff.parentSession,
          setup: async (session) => seedSession(session, handoff),
          withSession: async (fresh) => {
            if (!task) return;
            fresh.sendUserMessage(START_PROMPT).catch((error: unknown) => {
              fresh.ui.notify(`Could not start the handed-off task: ${error instanceof Error ? error.message : String(error)}`, "error");
            });
          },
        });
        if (outcome.cancelled) ctx.ui.notify("Handoff cancelled; this session is unchanged.", "warning");
      } finally {
        if (request === current) request = undefined;
      }
    },
  });
}
