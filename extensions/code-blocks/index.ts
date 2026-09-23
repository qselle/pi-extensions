import { getLanguageFromPath, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { disposeSyntax, highlightSyntax, initializeSyntax } from "../../lib/syntax.ts";
import { createCodeBlockFormatter } from "./format.ts";

export default async function codeBlocksExtension(pi: ExtensionAPI): Promise<void> {
  // Native Markdown caches source before running display transformers. Prepare
  // grammars before the first render so the cache never captures a cold fallback.
  await initializeSyntax();
  let ui: ExtensionUIContext | undefined;
  pi.on("session_start", (_event, ctx) => { ui = ctx.ui; });
  pi.on("session_shutdown", () => { disposeSyntax(); });
  const format = createCodeBlockFormatter(getLanguageFromPath, highlightSyntax);
  const native = createCodeBlockFormatter(getLanguageFromPath);
  pi.registerMarkdownTransformer((markdown, context) => context.messageType === "assistant" || context.messageType === "assistant-thinking"
    ? (ui?.theme.name === "gruvbox-dark" ? format : native)(markdown)
    : markdown);
}
