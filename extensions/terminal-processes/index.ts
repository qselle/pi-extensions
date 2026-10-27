import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolPurposeParameter } from "../../lib/tool-purpose.ts";
import { renderCall, renderResult } from "./render.ts";
import { ENTRY, TerminalProcesses } from "./service.ts";

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
      renderShell: "self",
      renderCall: (args, theme, context) => renderCall(args as Parameters<typeof renderCall>[0], theme, context),
      renderResult: (result, options, theme, context) => renderResult(result as Parameters<typeof renderResult>[0], options, theme, context),
    });
  });
  pi.on("session_tree", (_event, ctx) => service.restore(ctx));
  pi.on("session_shutdown", () => service.stop());
}
