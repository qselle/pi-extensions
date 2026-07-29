import type {
  ForgetMemoryResult,
  MemorySearchResult,
  MemoryStatus,
  RememberMemoryResult,
  ScopedMemoryRecord,
} from "./types.ts";

export const MAX_MEMORY_TOOL_OUTPUT_CHARS = 12_000;

export function formatMemoryStatus(status: MemoryStatus, enabled = true): string {
  const lines = [
    `memory: ${enabled ? "enabled" : "disabled"}`,
    `root: ${status.root}`,
  ];
  for (const scope of status.scopes) {
    lines.push(
      `${scope.scope}: ${scope.active} active, ${scope.expired} expired`,
      `  path: ${scope.path}`,
    );
    if (scope.projectRoot) lines.push(`  project: ${scope.projectRoot}`);
  }
  lines.push("contents are loaded only by memory search/read; no session history is preloaded");
  return boundOutput(lines.join("\n"));
}

export function formatDisabledMemory(root: string): string {
  return [
    "memory: disabled",
    `root: ${root}`,
    "Run /memory enable, then /reload to register the memory tool.",
  ].join("\n");
}

export function formatMemorySearch(query: string, results: MemorySearchResult[]): string {
  if (results.length === 0) return `No active memory matched “${singleLine(query)}”.`;
  const lines = [`Memory matches for “${singleLine(query)}” (${results.length}):`];
  for (const result of results) {
    const tags = result.tags.length > 0 ? ` · tags: ${result.tags.join(", ")}` : "";
    const expiry = result.expired
      ? ` · expired ${result.expiresAt}`
      : result.expiresAt
        ? ` · expires ${result.expiresAt}`
        : "";
    lines.push(
      `- ${result.id} · ${result.scope} · updated ${result.updatedAt}${expiry}${tags}`,
      `  ${singleLine(result.snippet)}`,
    );
  }
  lines.push("Use memory read with an ID for the full bounded record. Verify drift-prone facts against current files.");
  return boundOutput(lines.join("\n"));
}

export function formatMemoryRecord(record: ScopedMemoryRecord): string {
  const lines = [
    `Memory ${record.id}`,
    `scope: ${record.scope}${record.projectRoot ? ` (${record.projectRoot})` : ""}`,
    `created: ${record.createdAt}`,
    `updated: ${record.updatedAt}`,
    `status: ${record.expired ? "expired" : "active"}${record.expiresAt ? ` (expires ${record.expiresAt})` : ""}`,
    `tags: ${record.tags.length > 0 ? record.tags.join(", ") : "(none)"}`,
    `source: explicit request in ${record.source.cwd}${record.source.sessionId ? ` · session ${record.source.sessionId}` : ""}`,
    "---",
    sanitizeText(record.text),
  ];
  return boundOutput(lines.join("\n"));
}

export function formatRemembered(result: RememberMemoryResult): string {
  return boundOutput([
    `${result.created ? "Remembered" : "Refreshed"} ${result.record.id} in ${result.record.scope} memory.`,
    `path: ${result.path}`,
    `updated: ${result.record.updatedAt}`,
    result.record.expiresAt ? `expires: ${result.record.expiresAt}` : "expires: never",
  ].join("\n"));
}

export function formatForgotten(id: string, result: ForgetMemoryResult): string {
  if (!result.forgotten) return `Memory ${id} was not found in global or current-project scope.`;
  return boundOutput([
    `Forgot ${result.forgotten.id} from ${result.forgotten.scope} memory.`,
    `path: ${result.path}`,
    "The record was removed from the current store; filesystem snapshots or backups are outside the extension's control.",
  ].join("\n"));
}

export function mutationPreview(action: "remember" | "forget", detail: string, scope?: string): string {
  const heading = action === "remember"
    ? `Write this ${scope ?? "selected"} memory?`
    : "Permanently remove this memory from the current store?";
  return boundOutput(`${heading}\n\n${sanitizeText(detail)}`, 1_500);
}

export function boundOutput(text: string, limit = MAX_MEMORY_TOOL_OUTPUT_CHARS): string {
  const clean = sanitizeText(text);
  if (Array.from(clean).length <= limit) return clean;
  return `${Array.from(clean).slice(0, Math.max(0, limit - 24)).join("")}\n… [output truncated]`;
}

export function sanitizeText(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}

function singleLine(text: string): string {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}
