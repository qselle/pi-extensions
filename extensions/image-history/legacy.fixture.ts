import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LEGACY_DETAILS, LEGACY_PLACEHOLDER } from "./legacy.ts";

/** Write a sidecar blob in the earlier store's content-addressed layout. */
export async function writeLegacyBlob(agentDir: string, bytes: Buffer, extension = "png") {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(agentDir, "image-store", "sha256", digest.slice(0, 2));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest}.${extension}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return { digest, path, ref: { digest, mimeType: extension === "jpg" ? "image/jpeg" : "image/png", bytes: bytes.length } };
}

export const legacyToolResult = (refs: unknown[], text = "Read image file [image/png]") => ({
  role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, timestamp: 1,
  content: [{ type: "text", text }, ...refs.map(() => ({ type: "text", text: LEGACY_PLACEHOLDER }))] as any[],
  details: { [LEGACY_DETAILS]: { version: 1, refs } },
});
