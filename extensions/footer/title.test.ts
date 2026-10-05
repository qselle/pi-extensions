import { afterEach, expect, jest, test } from "bun:test";
import footerExtension, { TITLE_RESYNC_MS } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function setup() {
  const handlers = new Map<string, Handler[]>();
  let sessionName: string | undefined = "Footer polish";
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    events: { on: () => () => {}, emit: () => {} },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    getThinkingLevel: () => "off",
    getSessionName: () => sessionName,
  };
  footerExtension(pi as any);
  const titles: string[] = [];
  const ctx = {
    mode: "tui",
    cwd: "/work/project",
    isIdle: () => true,
    ui: { setTitle: (title: string) => titles.push(title), setFooter: () => {} },
  };
  const fire = (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) handler(event, ctx);
  };
  /** Simulates Pi's own title update, which bypasses the extension. */
  const hostRewrite = () => titles.push(`π - ${sessionName} - project`);
  return { fire, titles, hostRewrite, rename: (name: string) => { sessionName = name; } };
}

afterEach(() => jest.useRealTimers());

test("re-applies the terminal title once after Pi rewrites it on session start", () => {
  jest.useFakeTimers();
  const { fire, titles, hostRewrite } = setup();
  fire("session_start", { reason: "startup" });
  expect(titles.at(-1)).toBe("π Footer polish · project");
  hostRewrite();
  jest.advanceTimersByTime(TITLE_RESYNC_MS);
  expect(titles.at(-1)).toBe("π Footer polish · project");
  const count = titles.length;
  jest.advanceTimersByTime(TITLE_RESYNC_MS * 10);
  expect(titles.length).toBe(count);
  fire("session_shutdown");
});

test("re-applies the terminal title after reload and an unchanged rename", () => {
  jest.useFakeTimers();
  const { fire, titles, hostRewrite } = setup();
  fire("session_start", { reason: "startup" });
  jest.advanceTimersByTime(TITLE_RESYNC_MS);

  fire("session_shutdown");
  hostRewrite();
  fire("session_start", { reason: "reload" });
  hostRewrite();
  jest.advanceTimersByTime(TITLE_RESYNC_MS);
  expect(titles.at(-1)).toBe("π Footer polish · project");

  // Pi updates its title before extensions see session_info_changed.
  hostRewrite();
  fire("session_info_changed", { name: "Footer polish" });
  expect(titles.at(-1)).toBe("π Footer polish · project");
  fire("session_shutdown");
  expect(titles.at(-1)).toBe("pi");
  jest.advanceTimersByTime(TITLE_RESYNC_MS * 2);
  expect(titles.at(-1)).toBe("pi");
});
