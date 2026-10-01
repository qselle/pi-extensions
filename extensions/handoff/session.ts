import { rmSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const HANDOFF_MESSAGE = "handoff";
/** First prompt of a new session that received a task. */
export const START_PROMPT = "Start the handed-off task.";

export interface Handoff {
  summary: string;
  task?: string;
  parentSession?: string;
}

export interface SessionSettings {
  model?: { provider: string; id: string };
  thinkingLevel?: Parameters<SessionManager["appendThinkingLevelChange"]>[0];
}

/** Context the new session starts from, instead of the parent's history. */
export function handoffText({ summary, task, parentSession }: Handoff): string {
  return [
    task
      ? `You own this task, handed off from another Pi session, which will not work on it: ${task}`
      : "You continue work handed off from another Pi session.",
    parentSession
      ? `Parent session file: ${parentSession}. Treat it as read-only; search it only for details the summary omits.`
      : "The parent session was not saved.",
    "The summary may be incomplete: verify files and evidence before relying on it.",
    "",
    "## Handoff summary",
    "",
    summary.trim(),
  ].join("\n");
}

/** Add the handoff context to a session; the settings matter only for a separate Pi process. */
export function seedSession(session: SessionManager, handoff: Handoff, settings: SessionSettings = {}): void {
  if (settings.model) session.appendModelChange(settings.model.provider, settings.model.id);
  if (settings.thinkingLevel) session.appendThinkingLevelChange(settings.thinkingLevel);
  session.appendCustomMessageEntry(HANDOFF_MESSAGE, handoffText(handoff), true, { task: handoff.task, parentSession: handoff.parentSession });
}

/**
 * Write a new session for another Pi process. Pi saves a session only after
 * its first reply, so the file is written here with its header and context.
 */
export function createHandoffSession(cwd: string, sessionDir: string, handoff: Handoff, settings: SessionSettings): string {
  const session = SessionManager.create(cwd, sessionDir, handoff.parentSession ? { parentSession: handoff.parentSession } : undefined);
  seedSession(session, handoff, settings);
  const path = session.getSessionFile();
  if (!path) throw new Error("Failed to create the handoff session.");
  const lines = [session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(path, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  return path;
}

/** Cleanup must not throw over the error that triggered it. */
export function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A leftover file is an unused session.
  }
}
