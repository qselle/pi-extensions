import { describe, expect, test } from "bun:test";
import { titleConversation, type ConversationTitleState } from "./conversation.ts";
import type { TitleResult } from "./request.ts";

function harness(results: TitleResult[] = [{ title: "Generated Title" }]) {
  const prompts: string[] = [];
  const applied: string[] = [];
  let index = 0;
  return {
    prompts,
    applied,
    request: async (prompt: string) => { prompts.push(prompt); return results[Math.min(index++, results.length - 1)]!; },
    apply: (title: string) => applied.push(title),
  };
}

describe("titleConversation", () => {
  test("titles after the first user text", async () => {
    const h = harness();
    const state: ConversationTitleState = {};
    const result = await titleConversation({ userTexts: ["fix the retry loop"], state, request: h.request, apply: h.apply });
    expect(result?.title).toBe("Generated Title");
    expect(h.applied).toEqual(["Generated Title"]);
    expect(state.titledAtTurn).toBe(1);
  });

  test("skips an empty conversation", async () => {
    const h = harness();
    expect(await titleConversation({ userTexts: [], state: {}, request: h.request, apply: h.apply })).toBeUndefined();
    expect(h.prompts).toHaveLength(0);
  });

  test("builds the prompt from the anchor and later texts", async () => {
    const h = harness();
    await titleConversation({
      userTexts: ["first thing", "second thing", "third thing"],
      currentTitle: "Old title",
      state: {},
      request: h.request,
      apply: h.apply,
    });
    expect(h.prompts[0]).toContain("first_request: first thing");
    expect(h.prompts[0]).toContain("- second thing");
    expect(h.prompts[0]).toContain("current_title: Old title");
  });

  test("waits for the refresh interval", async () => {
    const h = harness();
    const state: ConversationTitleState = { titledAtTurn: 1 };
    expect(await titleConversation({ userTexts: ["a", "b"], state, request: h.request, apply: h.apply, refreshEvery: 5 }))
      .toBeUndefined();
    expect(await titleConversation({
      userTexts: ["a", "b", "c", "d", "e", "f"], state, request: h.request, apply: h.apply, refreshEvery: 5,
    })).toBeTruthy();
  });

  test("never titles after a manual rename", async () => {
    const h = harness();
    const result = await titleConversation({
      userTexts: ["a"], state: { manual: true }, request: h.request, apply: h.apply,
    });
    expect(result).toBeUndefined();
    expect(h.prompts).toHaveLength(0);
  });

  test("does not apply an unchanged title", async () => {
    const h = harness([{ title: "Same Title" }]);
    await titleConversation({ userTexts: ["a"], currentTitle: "Same Title", state: {}, request: h.request, apply: h.apply });
    expect(h.applied).toHaveLength(0);
  });

  test("marks the turn before awaiting, so concurrent answers fire one request", async () => {
    const h = harness();
    const state: ConversationTitleState = {};
    const texts = ["a"];
    await Promise.all([
      titleConversation({ userTexts: texts, state, request: h.request, apply: h.apply }),
      titleConversation({ userTexts: texts, state, request: h.request, apply: h.apply }),
    ]);
    expect(h.prompts).toHaveLength(1);
  });

  test("a failure does not block the next attempt", async () => {
    const h = harness([{ error: "rate limited" }, { title: "Second Try" }]);
    const state: ConversationTitleState = {};
    await titleConversation({ userTexts: ["a"], state, request: h.request, apply: h.apply });
    expect(h.applied).toHaveLength(0);
    expect(state.titledAtTurn).toBeUndefined();

    await titleConversation({ userTexts: ["a"], state, request: h.request, apply: h.apply });
    expect(h.applied).toEqual(["Second Try"]);
  });
});
