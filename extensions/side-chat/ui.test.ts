import { expect, mock, test } from "bun:test";
import type { SideChat, SideModelRef } from "./types.ts";

// The repo convention (7 test files) is to mock @earendil-works/pi-tui and then
// dynamically import the subject, because Bun applies module mocks
// process-globally and never restores them. This keeps the UI test hermetic and
// deterministic regardless of sibling suites. The real pi-tui integration is
// exercised separately (see the extension loading in a live pi session).
const decode: Record<string, string> = {
  "\r": "enter",
  "\n": "enter",
  "\x1b": "escape",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
  "\x1b[H": "home",
  "\x1b[F": "end",
  "\x0f": "ctrl+o",
  "\x12": "ctrl+r",
  "\x18": "ctrl+x",
};

const visibleWidth = (value: string): number => value.length;

class MockInput {
  private value = "";
  focused = false;
  getValue() {
    return this.value;
  }
  setValue(value: string) {
    this.value = value;
  }
  handleInput(data: string) {
    if (data === "\x7f" || data === "backspace") this.value = this.value.slice(0, -1);
    else if (data.length === 1 && data >= " ") this.value += data;
  }
  render(width: number) {
    return [this.value.slice(0, width)];
  }
  invalidate() {}
}

mock.module("@earendil-works/pi-tui", () => ({
  Input: MockInput,
  Key: {
    escape: "escape",
    enter: "enter",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
    pageUp: "pageUp",
    pageDown: "pageDown",
    home: "home",
    end: "end",
    ctrl: (key: string) => `ctrl+${key}`,
  },
  matchesKey: (data: string, keyId: string) => (decode[data] ?? data) === keyId,
  truncateToWidth: (value: string, width: number) => (value.length <= width ? value : value.slice(0, width)),
  visibleWidth,
  wrapTextWithAnsi: (value: string, width: number) => {
    const out: string[] = [];
    for (const line of String(value).split("\n")) {
      if (line.length <= width) out.push(line);
      else for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
    }
    return out.length ? out : [""];
  },
}));

const { renderPromotedMessage, renderSideCard, SideChatWorkspace, statusSymbol } = await import("./ui.ts");
const { SideChatStore } = await import("./store.ts");
type Store = InstanceType<typeof SideChatStore>;

const MODEL: SideModelRef = { provider: "openai", id: "gpt-5", api: "openai-responses" };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const keybindings = { matches: () => false } as never;

const KEY = { down: "\x1b[B", enter: "\r", escape: "\x1b", ctrlO: "\x0f" };

function fakeTui() {
  const tui = { requestRender: () => {}, terminal: { rows: 30 } } as never;
  return tui;
}

function chat(store: Store, title: string): SideChat {
  return store.create({ model: MODEL, systemPrompt: "boundary", contextMode: "snapshot", title });
}

function newStore(): Store {
  let counter = 0;
  return new SideChatStore({ runModel: () => new Promise(() => {}), now: () => 1, newId: () => `c${++counter}` });
}

function harness(seed: (store: Store) => void = () => {}) {
  const store = newStore();
  seed(store);
  const promoted: string[] = [];
  const created: SideChat[] = [];
  const callbacks = {
    list: () => store.list(),
    onSend: (id: string, text: string) => {
      store.send(id, text);
    },
    onRetry: (id: string) => store.retry(id),
    onAbort: (id: string) => store.abort(id),
    onPromote: (id: string) => {
      promoted.push(id);
      return "promoted";
    },
    onNew: () => {
      const c = chat(store, "New side chat");
      created.push(c);
      return c;
    },
    onDelete: (id: string) => store.remove(id),
  };
  let closed = 0;
  const workspace = new SideChatWorkspace(callbacks, theme, keybindings, fakeTui(), () => {
    closed += 1;
  });
  return { store, workspace, promoted, created, closed: () => closed };
}

test("list view renders chat titles and a header count", () => {
  const h = harness((store) => {
    chat(store, "debug 500");
    chat(store, "regex idea");
  });
  const lines = h.workspace.render(80).join("\n");
  expect(lines).toContain("Side chats");
  expect(lines).toContain("debug 500");
  expect(lines).toContain("regex idea");
});

test("empty list shows the getting-started hint", () => {
  const h = harness();
  expect(h.workspace.render(80).join("\n")).toContain("No side chats yet");
});

test("every rendered line stays within the requested width", () => {
  const h = harness((store) => chat(store, "a very ".repeat(30) + "long title"));
  for (const width of [20, 40, 80]) {
    for (const line of h.workspace.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
});

test("arrow navigation moves selection and Enter opens the chat", () => {
  const h = harness((store) => {
    chat(store, "first");
    chat(store, "second");
  });
  h.workspace.handleInput(KEY.down);
  h.workspace.handleInput(KEY.enter);
  const view = h.workspace.render(80).join("\n");
  expect(view).toContain("second");
  expect(view).toContain("context: main-conversation snapshot");
});

test("typing a follow-up and pressing Enter sends it to the store", () => {
  const h = harness((store) => chat(store, "chat"));
  h.workspace.handleInput(KEY.enter);
  for (const ch of "why?") h.workspace.handleInput(ch);
  h.workspace.handleInput(KEY.enter);
  const live = h.store.list()[0];
  expect(live.status).toBe("generating");
  expect(live.pending?.text).toBe("why?");
  const view = h.workspace.render(80).join("\n");
  expect(view).toContain("why?");
  expect(view).toContain("thinking…");
});

test("Escape exits the chat view, and closes the workspace from the list", () => {
  const h = harness((store) => chat(store, "chat"));
  h.workspace.handleInput(KEY.enter);
  h.workspace.handleInput(KEY.escape);
  expect(h.workspace.render(80).join("\n")).toContain("Side chats");
  expect(h.closed()).toBe(0);
  h.workspace.handleInput(KEY.escape);
  expect(h.closed()).toBe(1);
});

test("pressing n creates and opens a new chat", () => {
  const h = harness();
  h.workspace.handleInput("n");
  expect(h.created).toHaveLength(1);
  expect(h.store.count()).toBe(1);
});

test("Ctrl+Shift+S closes the workspace while chats keep running in the background", () => {
  const h = harness((store) => {
    const c = chat(store, "chat");
    store.send(c.id, "still generating");
  });
  h.workspace.handleInput("ctrl+shift+s");
  expect(h.closed()).toBe(1);
  // The store is untouched: background generation continues after the UI closes.
  expect(h.store.activeCount()).toBe(1);
});

test("Ctrl+Shift+S also closes from the chat view", () => {
  const h = harness((store) => chat(store, "chat"));
  h.workspace.handleInput(KEY.enter);
  h.workspace.handleInput("ctrl+shift+s");
  expect(h.closed()).toBe(1);
});

test("pressing d twice deletes the selected chat", () => {
  const h = harness((store) => {
    chat(store, "keep");
    chat(store, "drop");
  });
  h.workspace.handleInput(KEY.down);
  h.workspace.handleInput("d");
  h.workspace.handleInput("d");
  expect(h.store.list().map((c) => c.title)).toEqual(["keep"]);
});

test("Ctrl+O in the chat view promotes the chat", () => {
  const h = harness((store) => chat(store, "chat"));
  h.workspace.handleInput(KEY.enter);
  h.workspace.handleInput(KEY.ctrlO);
  expect(h.promoted).toEqual(["c1"]);
});

test("renderSideCard lists generating chats first", () => {
  const store = newStore();
  chat(store, "idle one");
  const busy = chat(store, "busy one");
  store.send(busy.id, "go");
  const lines = renderSideCard(store.list(), 40, 5, theme);
  expect(lines[0]).toContain("busy one");
  expect(lines.join("\n")).toContain("generating…");
});

test("renderPromotedMessage renders a labeled block within width", () => {
  const component = renderPromotedMessage("Side question: q\n\nSide answer:\nbecause", theme);
  const lines = component.render(50);
  expect(lines[0]).toContain("Promoted side answer");
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
});

test("statusSymbol reflects lifecycle", () => {
  const base = { status: "idle" } as SideChat;
  expect(statusSymbol(base, theme)).toBe("✓");
  expect(statusSymbol({ ...base, status: "generating" } as SideChat, theme)).toBe("●");
  expect(statusSymbol({ ...base, status: "error" } as SideChat, theme)).toBe("×");
});
