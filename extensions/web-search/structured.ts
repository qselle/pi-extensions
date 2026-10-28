import { Type } from "typebox";
import type { SearchResult } from "./client.ts";
import type { PageResult } from "./reader.ts";

/**
 * Structured results for programmatic callers such as codemode scripts. The model
 * keeps reading the formatted text; these carry the same facts without prose.
 */
const literals = <const T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const providers = literals(["exa", "firecrawl", "mistral"]);

export const SEARCH_OUTPUT_SCHEMA = Type.Object({
  provider: providers,
  query: Type.String(),
  results: Type.Array(Type.Object({
    rank: Type.Number(),
    title: Type.String(),
    url: Type.Optional(Type.String()),
    article_id: Type.Optional(Type.String({ description: "Mistral article without a URL; open with web_read" })),
    snippet: Type.String(),
    published: Type.Optional(Type.String()),
    date_uncertain: Type.Optional(Type.Boolean()),
  })),
  route: Type.Optional(Type.Array(Type.Object({ provider: providers, outcome: literals(["failed", "succeeded"]), reason: Type.Optional(Type.String()) }), { description: "Providers tried, after a fallback" })),
  warning: Type.Optional(Type.String()),
});

export function searchStructured(result: SearchResult) {
  return {
    provider: result.provider, query: result.query,
    results: result.results.map((hit, index) => ({
      rank: index + 1, title: hit.title,
      ...(hit.url !== undefined ? { url: hit.url } : {}), ...(hit.articleId !== undefined && hit.url === undefined ? { article_id: hit.articleId } : {}),
      snippet: hit.snippet, ...(hit.published ? { published: hit.published } : {}), ...(hit.dateUncertain ? { date_uncertain: true } : {}),
    })),
    ...(result.attempts?.length ? { route: result.attempts.map(({ provider, outcome, reason }) => ({ provider, outcome, ...(reason ? { reason } : {}) })) } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

export const READ_OUTPUT_SCHEMA = Type.Object({
  url: Type.String(),
  reader: literals(["ax", "exa", "firecrawl", "mistral"]),
  content: Type.String(),
  truncated: Type.Boolean(),
  source_url: Type.Optional(Type.String({ description: "Provider-reported final URL" })),
  selection: Type.Optional(literals(["more", "complete", "past_end"])),
  next_offset: Type.Optional(Type.Number({ description: "Pass as offset to continue the selection" })),
});

export function pageStructured(result: PageResult) {
  return {
    url: result.url, reader: result.reader ?? "ax", content: result.text, truncated: result.truncated,
    ...(result.sourceUrl ? { source_url: result.sourceUrl } : {}),
    ...(result.pagination ? { selection: result.pagination.state } : {}),
    ...(result.pagination?.nextOffset != null ? { next_offset: result.pagination.nextOffset } : {}),
  };
}
