import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  fileUri,
  getHyperlinkMode,
  hyperlinkPath,
  hyperlinksEnabled,
  setHyperlinkMode,
  supportsHyperlinks,
  toAbsolutePath,
  type HyperlinkMode,
} from "./link.ts";

export {
  closeDanglingLink,
  fileUri,
  hasDanglingLink,
  hasUriScheme,
  hyperlinkPath,
  hyperlinkUrl,
  hyperlinksEnabled,
  link,
  supportsHyperlinks,
  toAbsolutePath,
  type HyperlinkMode,
} from "./link.ts";

const CONFIG_FILE = "hyperlinks.json";

export function agentDirectory(): string {
  return getAgentDir();
}

export function loadMode(directory = agentDirectory()): HyperlinkMode | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, CONFIG_FILE), "utf8")) as unknown;
    const raw = (parsed as { mode?: unknown } | null)?.mode;
    return raw === "auto" || raw === "always" || raw === "never" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export interface HyperlinksExtensionOptions {
  configDirectory?: string;
}

export default function hyperlinksExtension(
  pi: ExtensionAPI,
  options: HyperlinksExtensionOptions = {},
): void {
  const configured = loadMode(options.configDirectory ?? agentDirectory());
  if (configured) setHyperlinkMode(configured);

  pi.registerCommand("hyperlinks", {
    description: "Show or set clickable-path support: /hyperlinks [auto|always|never]",
    getArgumentCompletions: (prefix) => {
      const items = ["auto", "always", "never"]
        .filter((value) => value.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested === "auto" || requested === "always" || requested === "never") {
        setHyperlinkMode(requested);
        ctx.ui.notify(`Hyperlinks set to ${requested} (active: ${hyperlinksEnabled()}).`, "info");
        return;
      }
      if (requested) {
        ctx.ui.notify("Usage: /hyperlinks [auto|always|never]", "error");
        return;
      }
      ctx.ui.notify(
        [
          `mode: ${getHyperlinkMode()}`,
          `active: ${hyperlinksEnabled()}`,
          `terminal detected: ${supportsHyperlinks() ? "supports OSC 8" : "no OSC 8"}`,
          `TERM_PROGRAM: ${process.env.TERM_PROGRAM ?? "(unset)"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("open-path", {
    description: "Print a clickable link to a path: /open-path <path>",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /open-path <path>", "error");
        return;
      }
      const absolute = toAbsolutePath(target, ctx.cwd);
      if (!existsSync(absolute)) {
        ctx.ui.notify(`Path does not exist: ${absolute}`, "error");
        return;
      }
      ctx.ui.notify(
        hyperlinksEnabled()
          ? `${hyperlinkPath(target, absolute, ctx.cwd)}  ${fileUri(absolute)}`
          : fileUri(absolute),
        "info",
      );
    },
  });
}
