import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import sessionSearchExtension from "./index.ts";
import type { SessionSearchResult, SessionSearchSummary } from "./search.ts";

class MockPi {
  commands = new Map<string, any>();
  tools: any[] = [];
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  registerTool(tool: any) { this.tools.push(tool); }
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path: "/sessions/source.jsonl",
    id: "session-12345678",
    cwd: "/repo",
    name: "Router work",
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-02T00:00:00.000Z"),
    messageCount: 2,
    firstMessage: "Investigate router",
    allMessagesText: "",
    ...overrides,
  };
}

function searchResult(overrides: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    session: session(),
    score: 100,
    snippet: "Router failed with ECONNRESET",
    entryId: "entry-match",
    entryLabel: "assistant message",
    truncated: false,
    malformedLines: 0,
    oversizedLines: 0,
    ...overrides,
  };
}

function summary(results: SessionSearchResult[] = []): SessionSearchSummary {
  return {
    results,
    scannedSessions: 1,
    unreadableSessions: 0,
    truncatedSessions: 0,
    malformedLines: 0,
    oversizedLines: 0,
  };
}

function context(options: {
  mode?: string;
  input?: string;
  actions?: string[];
  switchCancelled?: boolean;
  currentSessionPath?: string;
} = {}) {
  const notifications: Array<{ message: string; level: string; replacement?: boolean }> = [];
  const statuses: Array<string | undefined> = [];
  const editor: string[] = [];
  const selectCalls: Array<{ title: string; choices: string[] }> = [];
  const switchCalls: string[] = [];
  const actions = [...(options.actions ?? [])];
  const ctx = {
    mode: options.mode ?? "tui",
    cwd: "/repo",
    sessionManager: { getSessionFile: () => options.currentSessionPath },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      input: async () => options.input,
      select: async (title: string, choices: string[]) => {
        selectCalls.push({ title, choices });
        const action = actions.shift();
        return action === "<first>" ? choices[0] : action;
      },
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      setEditorText: (text: string) => editor.push(text),
    },
    switchSession: async (path: string, switchOptions: any) => {
      switchCalls.push(path);
      if (!options.switchCancelled) {
        await switchOptions.withSession({
          ui: {
            notify: (message: string, level: string) => notifications.push({ message, level, replacement: true }),
          },
        });
      }
      return { cancelled: options.switchCancelled ?? false };
    },
  } as any;
  return { ctx, notifications, statuses, editor, selectCalls, switchCalls };
}

describe("registration and search flow", () => {
  test("registers only a user command with scope completions", () => {
    const pi = new MockPi();
    sessionSearchExtension(pi as any, { listSessions: async () => [] });
    expect(pi.commands.has("session-search")).toBe(true);
    expect(pi.tools).toEqual([]);
    expect(pi.commands.get("session-search").getArgumentCompletions("--c")).toEqual([
      { value: "--current ", label: "--current" },
    ]);
    expect(pi.commands.get("session-search").getArgumentCompletions("query ")).toBeNull();
  });

  test("rejects non-interactive modes without listing sessions", async () => {
    const pi = new MockPi();
    let listed = false;
    sessionSearchExtension(pi as any, { listSessions: async () => { listed = true; return []; } });
    const h = context({ mode: "json" });
    await pi.commands.get("session-search").handler("needle", h.ctx);
    expect(listed).toBe(false);
    expect(h.notifications.at(-1)).toEqual({ message: "Session search requires interactive TUI mode.", level: "error" });
  });

  test("prompts for a query, preserves current-project scope, and reports bounded scan warnings", async () => {
    const pi = new MockPi();
    const source = session();
    let searchedQuery = "";
    let selectedCurrent = false;
    sessionSearchExtension(pi as any, {
      listSessions: async (progress) => {
        progress?.(1, 1);
        return [source];
      },
      selectCurrent: (sessions, cwd) => {
        selectedCurrent = true;
        expect(sessions).toEqual([source]);
        expect(cwd).toBe("/repo");
        return { sessions: [source], projectRoot: "/repo", kind: "git" };
      },
      search: async (_sessions, query, options) => {
        searchedQuery = query;
        options.onProgress?.(1, 1);
        return {
          ...summary(),
          unreadableSessions: 1,
          truncatedSessions: 1,
          malformedLines: 2,
          oversizedLines: 3,
        };
      },
    });
    const h = context({ input: "router timeout" });
    await pi.commands.get("session-search").handler("--current", h.ctx);
    expect(selectedCurrent).toBe(true);
    expect(searchedQuery).toBe("router timeout");
    expect(h.notifications.at(-1)?.message).toContain("No current-project sessions matched");
    expect(h.notifications.at(-1)?.message).toContain("unreadable sessions skipped: 1");
    expect(h.notifications.at(-1)?.message).toContain("2 malformed, 3 oversized");
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  test("places a selected excerpt in the editor", async () => {
    const pi = new MockPi();
    sessionSearchExtension(pi as any, {
      listSessions: async () => [session()],
      search: async () => summary([searchResult()]),
    });
    const h = context({ actions: ["<first>", "Put excerpt in editor"] });
    await pi.commands.get("session-search").handler("ECONNRESET", h.ctx);
    expect(h.editor).toEqual(["Router failed with ECONNRESET"]);
    expect(h.selectCalls).toHaveLength(2);
    expect(h.statuses.at(-1)).toBeUndefined();
  });
});

describe("selected result actions", () => {
  test("copies through a supported backend and falls back to the editor", async () => {
    for (const copied of [true, false]) {
      const pi = new MockPi();
      const copiedText: string[] = [];
      sessionSearchExtension(pi as any, {
        listSessions: async () => [session()],
        search: async () => summary([searchResult()]),
        copy: async (text) => { copiedText.push(text); return copied; },
      });
      const h = context({ actions: ["<first>", "Copy matching excerpt"] });
      await pi.commands.get("session-search").handler("router", h.ctx);
      expect(copiedText).toEqual(["Router failed with ECONNRESET"]);
      if (copied) {
        expect(h.editor).toEqual([]);
        expect(h.notifications.at(-1)?.message).toBe("Matching excerpt copied.");
      } else {
        expect(h.editor).toEqual(["Router failed with ECONNRESET"]);
        expect(h.notifications.at(-1)?.level).toBe("warning");
      }
    }
  });

  test("resumes through replacement context and never reuses stale UI after success", async () => {
    const pi = new MockPi();
    sessionSearchExtension(pi as any, {
      listSessions: async () => [session()],
      search: async () => summary([searchResult()]),
    });
    const h = context({ actions: ["<first>", "Resume this session"] });
    await pi.commands.get("session-search").handler("router", h.ctx);
    expect(h.switchCalls).toEqual(["/sessions/source.jsonl"]);
    expect(h.notifications.at(-1)).toMatchObject({ message: "Resumed match for “router”.", replacement: true });
    expect(h.statuses.at(-1)).not.toBeUndefined();
  });

  test("does not switch when the selected session is already active", async () => {
    const pi = new MockPi();
    sessionSearchExtension(pi as any, {
      listSessions: async () => [session()],
      search: async () => summary([searchResult()]),
    });
    const h = context({ actions: ["<first>", "Resume this session"], currentSessionPath: "/sessions/source.jsonl" });
    await pi.commands.get("session-search").handler("router", h.ctx);
    expect(h.switchCalls).toEqual([]);
    expect(h.notifications.at(-1)?.message).toBe("This is already the active session.");
  });

  test("forks through the exact matching entry", async () => {
    const pi = new MockPi();
    const createdFrom: string[] = [];
    sessionSearchExtension(pi as any, {
      listSessions: async () => [session()],
      search: async () => summary([searchResult()]),
      openSession: () => ({
        getEntry: (id) => id === "entry-match" ? { id } : undefined,
        getLeafId: () => "leaf-entry",
        createBranchedSession: (id) => { createdFrom.push(id); return "/sessions/fork.jsonl"; },
      }),
    });
    const h = context({ actions: ["<first>", "Fork through the matching entry"] });
    await pi.commands.get("session-search").handler("router", h.ctx);
    expect(createdFrom).toEqual(["entry-match"]);
    expect(h.switchCalls).toEqual(["/sessions/fork.jsonl"]);
    expect(h.notifications.at(-1)).toMatchObject({ message: "Forked search match from session-.", replacement: true });
  });

  test("removes an unused fork when switching is cancelled", async () => {
    const pi = new MockPi();
    const removed: string[] = [];
    sessionSearchExtension(pi as any, {
      listSessions: async () => [session()],
      search: async () => summary([searchResult({ entryId: undefined })]),
      openSession: () => ({
        getEntry: () => undefined,
        getLeafId: () => "leaf-entry",
        createBranchedSession: (id) => id === "leaf-entry" ? "/sessions/fork.jsonl" : undefined,
      }),
      removeFile: async (path) => { removed.push(path); },
    });
    const h = context({ actions: ["<first>", "Fork through the matching entry"], switchCancelled: true });
    await pi.commands.get("session-search").handler("router", h.ctx);
    expect(removed).toEqual(["/sessions/fork.jsonl"]);
    expect(h.notifications.at(-1)?.message).toContain("unused fork was removed");
    expect(h.statuses.at(-1)).toBeUndefined();
  });
});
