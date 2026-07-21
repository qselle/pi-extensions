import type { Api } from "@earendil-works/pi-ai";

/** How much of the main conversation a side chat inherits at creation. */
export type SideContextMode = "none" | "snapshot";

/** Lifecycle of a single side chat. */
export type SideChatStatus = "idle" | "generating" | "error";

export type SideTurnRole = "user" | "assistant";

/** Compact, serializable token accounting shared across side chats. */
export interface SideUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** A model a side chat is pinned to. Plain data so it survives persistence. */
export interface SideModelRef {
  provider: string;
  id: string;
  api: Api;
  name?: string;
  contextWindow?: number;
}

/** One committed exchange turn in a side chat. */
export interface SideTurn {
  role: SideTurnRole;
  text: string;
  timestamp: number;
  /** Assistant-only: "provider/id" that produced the answer. */
  model?: string;
  /** Assistant-only: usage billed for this answer. */
  usage?: SideUsage;
}

/** An in-flight question that has not yet produced a committed answer. */
export interface SidePending {
  text: string;
  startedAt: number;
}

/**
 * A persistent, multi-turn side conversation that runs alongside — and
 * independently of — the main agent job.
 */
export interface SideChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  contextMode: SideContextMode;
  model: SideModelRef;
  /** Frozen system-prompt preamble: safety boundary + bounded main snapshot. */
  systemPrompt: string;
  /** Committed, strictly alternating user/assistant turns. */
  turns: SideTurn[];
  /** Transient in-flight question (set while generating or after an error). */
  pending?: SidePending;
  status: SideChatStatus;
  error?: string;
  /** Aggregate usage across every answer in this chat. */
  usage: SideUsage;
  /** Whether the inherited snapshot was truncated to fit the model window. */
  contextTruncated: boolean;
}

/** Placeholder title for a side chat before its first question names it. */
export const DEFAULT_SIDE_CHAT_TITLE = "New side chat";

export function modelLabel(model: SideModelRef): string {
  return `${model.provider}/${model.id}`;
}
