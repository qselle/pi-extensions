import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Public event-bus negotiation keeps the executor and renderer independent of load order. */
export const BASH_OWNER = "managed-bash:owner-v1";
export const BASH_STYLE = "managed-bash:style-v1";
export type BashStyle = Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">;
export interface BashOwnerRequest { claim: (definition: ToolDefinition<any>) => void; style?: BashStyle }
export interface BashStyleRequest { provide: (style: BashStyle, install: (definition: ToolDefinition<any>) => void) => void }
export function managedBashOwns(pi: ExtensionAPI, style: BashStyle): boolean {
  let owned = false;
  pi.events?.emit(BASH_OWNER, { style, claim: () => { owned = true; } } satisfies BashOwnerRequest);
  return owned;
}
