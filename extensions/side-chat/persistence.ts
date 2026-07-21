import { normalizeSideUsage } from "./usage.ts";
import { DEFAULT_SIDE_CHAT_TITLE } from "./types.ts";
import type {
  SideChat,
  SideChatStatus,
  SideContextMode,
  SideModelRef,
  SideTurn,
} from "./types.ts";

export const SIDE_META_ENTRY = "side-chat-meta";
export const SIDE_STATE_ENTRY = "side-chat-state";

/** Immutable metadata, written once at creation. Kept out of repeated writes. */
export interface SideMetaRecord {
  version: 1;
  id: string;
  createdAt: number;
  contextMode: SideContextMode;
  model: SideModelRef;
  systemPrompt: string;
  contextTruncated: boolean;
}

/** Mutable state, written on every change (last write wins per id). */
export interface SideStateRecord {
  version: 1;
  id: string;
  updatedAt: number;
  title: string;
  turns: SideTurn[];
  status: SideChatStatus;
  error?: string;
  pending?: { text: string; startedAt: number };
  usage: ReturnType<typeof normalizeSideUsage>;
  deleted: boolean;
}

export function metaRecord(chat: SideChat): SideMetaRecord {
  return {
    version: 1,
    id: chat.id,
    createdAt: chat.createdAt,
    contextMode: chat.contextMode,
    model: chat.model,
    systemPrompt: chat.systemPrompt,
    contextTruncated: chat.contextTruncated,
  };
}

export function stateRecord(chat: SideChat, deleted = false): SideStateRecord {
  return {
    version: 1,
    id: chat.id,
    updatedAt: chat.updatedAt,
    title: chat.title,
    turns: chat.turns,
    status: chat.status,
    error: chat.error,
    pending: chat.pending,
    usage: chat.usage,
    deleted,
  };
}

interface CustomEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

/**
 * Reconstruct all live side chats from an ordered list of session entries
 * (typically the active branch). Latest meta + latest state per id wins, and
 * a `deleted` state acts as a tombstone.
 */
export function restoreSideChats(entries: readonly unknown[]): SideChat[] {
  const metas = new Map<string, SideMetaRecord>();
  const states = new Map<string, SideStateRecord>();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as CustomEntryLike;
    if (candidate.type !== "custom") continue;
    if (candidate.customType === SIDE_META_ENTRY) {
      const meta = decodeMeta(candidate.data);
      if (meta) metas.set(meta.id, meta);
    } else if (candidate.customType === SIDE_STATE_ENTRY) {
      const state = decodeState(candidate.data);
      if (state) states.set(state.id, state);
    }
  }

  const chats: SideChat[] = [];
  for (const [id, meta] of metas) {
    const state = states.get(id);
    if (state?.deleted) continue;
    chats.push(assemble(meta, state));
  }
  chats.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return chats;
}

function assemble(meta: SideMetaRecord, state: SideStateRecord | undefined): SideChat {
  const status: SideChatStatus = state?.status === "error" ? "error" : "idle";
  return {
    id: meta.id,
    title: state?.title ?? DEFAULT_SIDE_CHAT_TITLE,
    createdAt: meta.createdAt,
    updatedAt: state?.updatedAt ?? meta.createdAt,
    contextMode: meta.contextMode,
    model: meta.model,
    systemPrompt: meta.systemPrompt,
    turns: state?.turns ?? [],
    // Pending is only meaningful for retry after an error; drop it otherwise.
    pending: status === "error" ? state?.pending : undefined,
    status,
    error: status === "error" ? state?.error : undefined,
    usage: normalizeSideUsage(state?.usage),
    contextTruncated: meta.contextTruncated,
  };
}

function decodeMeta(value: unknown): SideMetaRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SideMetaRecord>;
  if (raw.version !== 1 || typeof raw.id !== "string") return undefined;
  const model = decodeModel(raw.model);
  if (!model) return undefined;
  return {
    version: 1,
    id: raw.id,
    createdAt: numberOr(raw.createdAt, 0),
    contextMode: raw.contextMode === "snapshot" ? "snapshot" : "none",
    model,
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : "",
    contextTruncated: Boolean(raw.contextTruncated),
  };
}

function decodeState(value: unknown): SideStateRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SideStateRecord> & { pending?: unknown };
  if (raw.version !== 1 || typeof raw.id !== "string") return undefined;
  return {
    version: 1,
    id: raw.id,
    updatedAt: numberOr(raw.updatedAt, 0),
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : DEFAULT_SIDE_CHAT_TITLE,
    turns: decodeTurns(raw.turns),
    status: decodeStatus(raw.status),
    error: typeof raw.error === "string" ? raw.error : undefined,
    pending: decodePending(raw.pending),
    usage: normalizeSideUsage(raw.usage),
    deleted: Boolean(raw.deleted),
  };
}

function decodeTurns(value: unknown): SideTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: SideTurn[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<SideTurn>;
    if (raw.role !== "user" && raw.role !== "assistant") continue;
    if (typeof raw.text !== "string") continue;
    turns.push({
      role: raw.role,
      text: raw.text,
      timestamp: numberOr(raw.timestamp, 0),
      model: typeof raw.model === "string" ? raw.model : undefined,
      usage: raw.usage ? normalizeSideUsage(raw.usage) : undefined,
    });
  }
  return turns;
}

function decodePending(value: unknown): { text: string; startedAt: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { text?: unknown; startedAt?: unknown };
  if (typeof raw.text !== "string" || !raw.text.trim()) return undefined;
  return { text: raw.text, startedAt: numberOr(raw.startedAt, 0) };
}

function decodeStatus(value: unknown): SideChatStatus {
  return value === "error" ? "error" : "idle";
}

function decodeModel(value: unknown): SideModelRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SideModelRef>;
  if (typeof raw.provider !== "string" || typeof raw.id !== "string" || typeof raw.api !== "string") {
    return undefined;
  }
  return {
    provider: raw.provider,
    id: raw.id,
    api: raw.api,
    name: typeof raw.name === "string" ? raw.name : undefined,
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
