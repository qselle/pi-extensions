import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { toolPurpose, toolPurposeParameter } from "../../lib/tool-purpose.ts";
import { ENTRY, plain, TerminalProcesses } from "./service.ts";

export default function terminalProcesses(pi: ExtensionAPI, options: ConstructorParameters<typeof TerminalProcesses>[1] = {}) {
  const service = new TerminalProcesses((record) => pi.appendEntry(ENTRY, record), options);
  let registered = false;
  pi.on("session_start", (_event, ctx) => {
    service.restore(ctx);
    if (registered || !service.available(ctx)) return;
    registered = true;
    pi.registerTool({
      name: "terminal_process", label: "Terminal process", executionMode: "sequential",
      description: "Explicitly start/list/read/status/input/interrupt persistent foreground commands in visible sibling Herdr panes. Focus stays in Pi. Only this Pi session's panes can be controlled. Read output is bounded; panes remain open after interruption, reload, or shutdown.",
      promptGuidelines: ["Use terminal_process start explicitly for visible development servers, watchers or interactive processes. Keep commands in the foreground; do not append &. Use read/status before retrying an unacknowledged action. Input text is private in the result but remains in tool arguments and may appear in terminal output."],
      parameters: Type.Object({
        purpose: toolPurposeParameter,
        action: Type.Union(["start", "list", "read", "status", "input", "interrupt"].map((value) => Type.Literal(value))),
        command: Type.Optional(Type.String({ minLength: 1, maxLength: 65536, description: "Exact foreground shell command for start." })),
        label: Type.Optional(Type.String({ maxLength: 80, description: "Short visible pane label; never include secrets." })),
        direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
        pane_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Recent rows for read; default 120." })),
        text: Type.Optional(Type.String({ maxLength: 65536, description: "Literal input. Never echoed by the tool result." })),
        press_enter: Type.Optional(Type.Boolean({ description: "Submit input with Enter; default true." })),
      }),
      execute: async (_id, args, signal, _update, ctx) => service.execute(args as Parameters<typeof service.execute>[0], ctx, signal),
      renderCall: (args, theme) => {
        const purpose = toolPurpose(args.purpose);
        return new Text(theme.fg("accent", `Terminal · ${plain(String(args.action ?? "process"))}`) + (purpose ? theme.fg("muted", ` · ${purpose}`) : ""), 0, 0);
      },
      renderResult: (result, options, theme) => {
        const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const rows = plain(text).split("\n");
        return new Text(theme.fg("muted", (options.expanded ? rows : rows.slice(0, 8)).join("\n") + (!options.expanded && rows.length > 8 ? "\n… expand for more" : "")), 0, 0);
      },
    });
  });
  pi.on("session_tree", (_event, ctx) => service.restore(ctx));
  pi.on("session_shutdown", () => service.stop());
}
