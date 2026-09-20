import { messageContentText } from "../history-search/history.ts";

export interface RewindPrompt {
  id: string;
  text: string;
  images: number;
  label: string;
}

/** Keep distinct entries even when their prompt text is identical. */
export function rewindPrompts(entries: readonly unknown[]): RewindPrompt[] {
  const prompts: RewindPrompt[] = [];
  for (const raw of entries) {
    const entry = raw as { id?: unknown; type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
    if (entry?.type !== "message" || typeof entry.id !== "string" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = messageContentText(content) ?? "";
    const images = Array.isArray(content) ? content.filter((part) => part?.type === "image").length : 0;
    if (!text.trim() && !images) continue;
    const preview = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
    prompts.push({
      id: entry.id, text, images,
      label: `#${prompts.length + 1}${images ? ` [${images} image${images === 1 ? "" : "s"}]` : ""} · ${preview.slice(0, 500) || "Image prompt"}`,
    });
  }
  return prompts.reverse();
}
