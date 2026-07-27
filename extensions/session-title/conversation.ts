/**
 * Titling policy for any conversation made of user texts: decides whether to
 * generate, builds the bounded prompt, and applies the result. Shared by session
 * titles and side-chat titles so both behave identically.
 */

import { DEFAULT_REFRESH_EVERY, buildTitlePrompt, shouldGenerate } from "./engine.ts";
import type { TitleResult } from "./request.ts";

export interface ConversationTitleState {
  /** userTexts length when the title was last generated. */
  titledAtTurn?: number;
  /** Set when the user named it by hand; titling stops for good. */
  manual?: boolean;
}

export interface TitleConversationOptions {
  /** User messages only, oldest first. */
  userTexts: readonly string[];
  /** Title currently shown, if it is not a placeholder. */
  currentTitle?: string;
  state: ConversationTitleState;
  refreshEvery?: number;
  request: (prompt: string) => Promise<TitleResult>;
  apply: (title: string) => void;
}

/**
 * Returns the request result, or undefined when titling was skipped. The state is
 * marked as titled before awaiting, so concurrent answers cannot both fire a
 * request for the same turn.
 */
export async function titleConversation(options: TitleConversationOptions): Promise<TitleResult | undefined> {
  const { userTexts, state, apply } = options;
  const refreshEvery = options.refreshEvery ?? DEFAULT_REFRESH_EVERY;
  if (!shouldGenerate({ userTurns: userTexts.length, titledAtTurn: state.titledAtTurn, manual: state.manual }, refreshEvery)) {
    return undefined;
  }

  const previous = state.titledAtTurn;
  state.titledAtTurn = userTexts.length;
  const result = await options.request(buildTitlePrompt({
    anchor: userTexts[0],
    recent: userTexts.slice(1),
    currentTitle: options.currentTitle,
  }));

  if (result.title && result.title !== options.currentTitle) apply(result.title);
  // A failed attempt should not block the next one.
  else if (!result.title) state.titledAtTurn = previous;
  return result;
}
