import { getLanguageFromPath, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodeBlockFormatter } from "./format.ts";

export default function codeBlocksExtension(pi: ExtensionAPI): void {
  const format = createCodeBlockFormatter(getLanguageFromPath);
  pi.registerMarkdownTransformer((markdown, context) => context.messageType === "assistant"
    ? format(markdown, context.isStreaming)
    : markdown);
}
