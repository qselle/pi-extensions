export interface TranscriptBlock {
  id: string;
  label: string;
  body: string;
  kind: "user" | "assistant" | "tool" | "thinking" | "summary" | "custom";
  failed?: boolean;
  labelColor?: "warning" | "success" | "muted";
  markdown?: boolean;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" ? value as RecordValue : {};

export function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return plainText(content);
  if (!Array.isArray(content)) return "";
  return content.map((value) => {
    const part = record(value);
    if (part.type === "text") return plainText(part.text);
    if (part.type === "image") return `[Image${typeof part.mimeType === "string" ? ` · ${plainText(part.mimeType)}` : ""}]`;
    return "";
  }).filter(Boolean).join("\n");
}

/** Extract displayable history without binary images or hidden extension context. */
export function transcriptBlocks(entries: readonly unknown[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = record(entries[index]);
    const id = typeof entry.id === "string" ? entry.id : `entry-${index}`;
    const add = (kind: TranscriptBlock["kind"], label: string, body: string, extra: Partial<TranscriptBlock> = {}) => {
      blocks.push({ id: `${id}:${blocks.length}`, kind, label, body: body || "(empty)", ...extra });
    };
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      add("summary", entry.type === "compaction" ? "Context summary" : "Branch summary", plainText(entry.summary), { markdown: true });
      continue;
    }
    if (entry.type === "custom_message") {
      if (entry.display === true) add("custom", plainText(entry.customType) || "Extension message", contentText(entry.content));
      continue;
    }
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (message.role === "assistant") {
      if (typeof message.content === "string") add("assistant", "Assistant", plainText(message.content), { markdown: true });
      else if (Array.isArray(message.content)) for (const raw of message.content) {
        const part = record(raw);
        if (part.type === "text") add("assistant", "Assistant", plainText(part.text), { markdown: true });
        else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) add("thinking", "Thinking", plainText(part.thinking));
        else if (part.type === "toolCall") {
          let args: string;
          try { args = JSON.stringify(part.arguments ?? {}, null, 2); }
          catch { args = "[Arguments could not be serialized]"; }
          add("tool", `Tool call · ${plainText(part.name) || "unknown"}`, plainText(args));
        }
      }
      if (message.errorMessage) add("assistant", "Assistant error", plainText(message.errorMessage), { failed: true });
    } else if (message.role === "user") add("user", "You", contentText(message.content));
    else if (message.role === "toolResult") add("tool", `${message.isError ? "Tool failed" : "Tool result"} · ${plainText(message.toolName) || "unknown"}`,
      contentText(message.content), { failed: message.isError === true });
    else if (message.role === "bashExecution") add("tool", "Shell", `${plainText(message.command)}\n${plainText(message.output)}`, { failed: typeof message.exitCode === "number" && message.exitCode !== 0 });
  }
  return blocks;
}
