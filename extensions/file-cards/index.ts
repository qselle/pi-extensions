import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEditTool,
  createEditToolDefinition,
  createWriteTool,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { FileMutationCard, type FileCardOperation } from "./ui.ts";

interface FileCardRenderState {
  card?: FileMutationCard;
}

interface RenderContext {
  args?: Record<string, unknown>;
  state: FileCardRenderState;
  lastComponent?: unknown;
  cwd?: string;
  expanded?: boolean;
  isError?: boolean;
}

/**
 * Replace only the presentation of Pi's native edit and write tools. Schemas,
 * argument preparation, prompt guidance, mutation queues, and execution stay
 * delegated to Pi's current built-in implementations.
 */
export default function fileCards(pi: ExtensionAPI) {
  registerFileTool(pi, "edit");
  registerFileTool(pi, "write");
}

function registerFileTool(pi: ExtensionAPI, operation: FileCardOperation): void {
  const native = operation === "edit"
    ? createEditToolDefinition(process.cwd())
    : createWriteToolDefinition(process.cwd());

  pi.registerTool({
    name: native.name,
    label: native.label,
    description: native.description,
    promptSnippet: native.promptSnippet,
    promptGuidelines: native.promptGuidelines,
    parameters: native.parameters,
    prepareArguments: native.prepareArguments,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tool = operation === "edit" ? createEditTool(ctx.cwd) : createWriteTool(ctx.cwd);
      return tool.execute(toolCallId, params as never, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      const renderContext = context as unknown as RenderContext;
      const state = renderContext.state;
      const card = state.card ?? new FileMutationCard(operation, theme);
      state.card = card;
      card.setCall(args as Record<string, unknown>, Boolean(renderContext.expanded), theme);
      return card;
    },

    renderResult(result, options, theme, context) {
      const renderContext = context as unknown as RenderContext;
      let card = renderContext.state.card;
      const createdHere = !card;
      if (!card) {
        card = new FileMutationCard(operation, theme);
        renderContext.state.card = card;
        card.setCall(renderContext.args, Boolean(options.expanded), theme);
      }
      card.setResult(result as any, Boolean(renderContext.isError), Boolean(options.expanded), theme);
      return createdHere ? card : new Container();
    },
  });
}
