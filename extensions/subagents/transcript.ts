import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { plainText, transcriptBlocks, type TranscriptBlock } from "../../lib/transcript/model.ts";
import { TranscriptView, type TranscriptNavigation } from "../../lib/transcript/view.ts";
import type { AgentSnapshot, AgentTranscript } from "./coordinator.ts";

/** Share Markdown, search, follow, and thinking controls with the parent viewer. */
export class LiveTranscriptViewer extends TranscriptView {
  constructor(load: () => AgentTranscript, theme: Theme, keybindings: KeybindingsManager, tui: TUI, done: () => void, navigation?: TranscriptNavigation) {
    let latest: AgentTranscript;
    super(() => {
      latest = load();
      return childTranscriptBlocks(latest);
    }, () => `Subagent · ${plainText(latest.agent.name)} · ${latest.agent.status}${navigation?.position ? ` · ${navigation.position()}` : ""}`,
    theme, keybindings, tui, done, "", "live", navigation);
  }
}

/** Stable creation order prevents tabs jumping when a child finishes. */
export function navigableAgents(agents: readonly AgentSnapshot[]): AgentSnapshot[] {
  return agents.filter((agent) => agent.status !== "closed")
    .sort((a, b) => (a.createdAt ?? a.startedAt) - (b.createdAt ?? b.startedAt) || a.name.localeCompare(b.name));
}

/** Keep each recently visited child's search/scroll state while switching. */
export class ChildTranscriptBrowser implements Component, Focusable {
  private readonly views = new Map<string, LiveTranscriptViewer>();
  private selected: string;
  private current!: LiveTranscriptViewer;
  private focusedValue = false;
  private closed = false;

  constructor(initial: string, private readonly agents: () => AgentSnapshot[], private readonly load: (name: string) => AgentTranscript,
    private readonly theme: Theme, private readonly keys: KeybindingsManager, private readonly tui: TUI,
    private readonly done: () => void, private readonly onSelect: (name: string) => void = () => {}) {
    this.selected = initial;
    this.select(initial, false);
  }

  get focused(): boolean { return this.focusedValue; }
  set focused(value: boolean) { this.focusedValue = value; this.current.focused = value; }
  render(width: number): string[] { return this.closed ? [] : this.current.render(width); }
  handleInput(data: string): void { if (!this.closed) this.current.handleInput(data); }
  invalidate(): void { for (const view of this.views.values()) view.invalidate(); }
  refresh(): void { if (!this.closed) this.current.refresh(); }
  close(): void { if (!this.closed) { this.closed = true; this.views.clear(); this.done(); } }

  private position(): { index: number; agents: AgentSnapshot[] } {
    const agents = navigableAgents(this.agents());
    return { agents, index: agents.findIndex((agent) => agent.name === this.selected) };
  }

  private navigate(direction: -1 | 1): void {
    const { agents, index } = this.position();
    if (direction < 0 && index <= 0) { this.close(); return; }
    const next = agents[index + direction];
    if (next) this.select(next.name);
  }

  private select(name: string, notify = true): void {
    if (this.current) this.current.focused = false;
    this.selected = name;
    let view = this.views.get(name);
    if (view) { this.views.delete(name); view.refresh(); }
    else view = new LiveTranscriptViewer(() => this.load(name), this.theme, this.keys, this.tui, () => this.close(), {
      previous: () => this.navigate(-1), next: () => this.navigate(1),
      hint: () => this.position().index <= 0 ? "← parent · → agents" : "←/→ agents",
      position: () => { const { index, agents } = this.position(); return index < 0 ? "closed" : `${index + 1}/${agents.length}`; },
    });
    this.views.set(name, view);
    while (this.views.size > 8) this.views.delete(this.views.keys().next().value!);
    this.current = view;
    view.focused = this.focusedValue;
    if (notify) this.onSelect(name);
    this.tui.requestRender();
  }
}

export function childTranscriptBlocks(transcript: AgentTranscript): TranscriptBlock[] {
  const { agent } = transcript;
  const runtime = `${agent.model ?? "inherited model"}${agent.thinking ? ` · ${agent.thinking}` : ""}`;
  const entries = transcriptBlocks(transcript.entries);
  const blocks: TranscriptBlock[] = [{
    id: "child-task",
    kind: "user",
    label: `Task · ${plainText(runtime)}`,
    body: plainText(agent.task),
    markdown: true,
  }, ...entries];
  if (agent.output && !entries.some((entry) => entry.kind === "assistant" && !entry.failed)) {
    blocks.push({ id: "child-retained-result", kind: "assistant", label: "Retained result", body: plainText(agent.output), markdown: true });
  }
  if (agent.error && !entries.some((entry) => entry.failed && entry.body === plainText(agent.error))) {
    blocks.push({ id: "child-error", kind: "custom", label: "Error", body: plainText(agent.error), failed: true });
  }
  return blocks;
}
