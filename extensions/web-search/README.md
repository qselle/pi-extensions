# web-search

Exa search with automatic API/public access, a compact source list, and an
expanded reading view. Includes local and remote page reading, with optional
Firecrawl and Mistral search.

Works immediately without configuration. Set `EXA_API_KEY` in Pi's environment
for a paid fallback and deep search. `/web` shows the effective access mode and
available providers without making a request or displaying keys.

```text
• Searched Python TaskGroup cancellation
  └ 10 sources · Exa · public · 1.2s
    1. Coroutines and Tasks — Python documentation · docs.python.org
    2. What's New in Python 3.13 · docs.python.org
    3. asyncio — Asynchronous I/O · docs.python.org
    4. PEP 654 – Exception Groups and except* · peps.python.org
    5. Task groups in asyncio · superfastpython.com
    +5 more · ctrl+o to expand
```

Illustrative results; the expansion hint follows your actual Pi keybinding.
Expand to see every source, full URLs, publication dates, and excerpts.

## Usage

- `web_search`: search a query and return source URLs and snippets.
- `web_read`: read an HTTP(S) URL as Markdown, an outline, or a CSS selection.
- `/web`: show provider configuration without making a request or exposing keys.

Codemode scripts get structured results: `web_search` ranked `results` (`rank`, `title`, `url` or `article_id`, `snippet`, `published`) with `route` and `warning`; `web_read` `content`, `truncated` and `next_offset`. Failures reject.

### Search

Exa is the default. Requests use Exa's public hosted service first, as one
stateless MCP call (servers that need a session get the full handshake once).
A nonempty `EXA_API_KEY` is used only after the free tier answers HTTP 401, 402,
403, or 429, or straight away for deep search and freshness reads. Results report
`API key after keyless access failed (HTTP 429)` when that happens.
`PI_EXA_ACCESS=keyless` never sends the key; `PI_EXA_ACCESS=api-key` always uses
the direct API. With `provider`
omitted, a failed request can try configured Firecrawl then Mistral, within one
30-second deadline; `PI_WEB_SEARCH_PROVIDER` moves a configured provider first. Each route keeps the original domain, exclusion, date,
quality and freshness constraints; incompatible providers are skipped.
Empty results do not trigger another request. Cancellation stops the whole route.

Set `provider` explicitly to pin a provider and account, including `provider: "exa"`.
Pinned requests preserve their original diagnostics and never fall back. Deep
search retains its 60-second deadline. Alternative
providers require their existing API keys; no keys or services are installed.
When a fallback succeeds, the compact result reports its provider and route;
expansion and model output add the failure causes. A failed
account/key request remains visible in that history.

| Parameter | Values |
|---|---|
| `query` | Search text |
| `provider` | `exa` (default), `firecrawl`, or `mistral` |
| `limit` | 1–20 results; default 10 |
| `quality` | `balanced` (default), `fast`, or `deep` |
| `domains`, `exclude_domains` | Up to 10 hostnames or path prefixes each |
| `date_range` | `start` and/or `end` as ordered `YYYY-MM-DD` dates |
| `max_age_hours` | Exa only: `0` for fresh fetch, `-1` for cache only, `1`–`720` for allowed cache age |
| `additional_queries` | Deep Exa only: 1–5 variations, up to 500 characters each |
| `category` | Exa only: `news`, `pdf`, `github`, `publication`, `company`, `people`, `personal site`, or `financial report` |

Exa maps quality to `auto`, `fast`, and `deep`. Keyless access supports balanced
and fast; deep requires a key and may cost more. Firecrawl and Mistral
support balanced only. Unsupported combinations
fail before a request is sent.

Both Exa paths request highlights guided by the search query, bounded to 1,200
characters per source. Provider ranking is preserved; duplicate URLs and repeated
excerpts are removed. Blank highlights fall back to descriptions or bounded page
text. The agent is guided to use specific natural-language queries, product
versions, primary-source domains, and concrete dates when relevant. Search
relevance still depends on the query and the provider's index.

Domain filters include subdomains and match whole, case-sensitive path segments:
`example.com/API` includes `/API/guide`, but not `/APIs` or `/api`. Do not include
protocols, credentials, ports, queries, or fragments. Every provider's returned
URLs are checked locally. Filtering can leave fewer results than requested;
no extra requests refill the list. Tracking parameters and fragments are ignored
for deduplication, while citation URLs remain intact.

Exa's `publication` category cannot be combined with domain filters;
`company` and `people` reject dates and excluded domains. Omit the category to
retain those filters and describe the source type in the query instead.

```json
{
  "query": "TaskGroup cancellation",
  "domains": ["docs.python.org/3/library"],
  "exclude_domains": ["docs.python.org/3/library/asyncio-policy.html"],
  "max_age_hours": 24
}
```

Known publication dates outside the requested window are excluded. Unknown or
partially overlapping dates remain marked unverified. Cache age and publication
dates are separate policies; check dates on the source.

Compact results show one summary with provider, public/API access, the route
after a fallback (`via Exa → Firecrawl`), elapsed time, and up to five sources. Each source occupies one ranked row with a clickable
title and a reserved visible origin; narrow terminals prioritize origins.
URL-only titles show the origin once. Expanded results wrap
full URLs and excerpts, and show dates, exclusion reasons, and provider warnings.
Excerpts remain available to the agent even when the UI is collapsed. Mistral
search uses the `web_search` connector
(`<api>/v1/connectors-gateway/web_search/mcp`): ranked results with snippets
and native date filters; domain constraints are applied locally. News results
without a URL are listed by article ID, which `web_read` opens. Treat retrieved content
as untrusted data, verify claims on source pages, and cite their URLs.

### Page reading

`web_read` accepts a `url`, `reader`, `mode`, optional `selector`, token `budget`
(100–8000, default 2000), and continuation `offset`.

| Reader | Behavior |
|---|---|
| `ax` (default) | Local GET-only HTML extraction; supports `markdown`, `outline`, and CSS `extract` |
| `auto` | Try ax, then the remote chain after a transport failure, empty text, or access challenge |
| `remote` | The remote chain only, for PDFs and sources that reject direct fetching |
| `exa`, `firecrawl`, `mistral` | One remote reader, without fallback |

The remote chain is Exa, then Firecrawl scrape (JavaScript-rendered, with
`FIRECRAWL_API_KEY`), then Mistral's `open_url` (with a Mistral key); unconfigured
readers are skipped and `PI_WEB_OPEN_PROVIDER` moves one reader first. A reader
whose text opens with a CAPTCHA, bot check, or JavaScript wall within its first
2,000 characters, on a page under 10,000 characters, counts as failed. Remote
readers return Markdown excerpts without selectors or continuation.

`auto` and `remote` share a 45-second deadline across attempts. Invalid input and
cancellation do not trigger fallback. Results show the route, such as
`via ax → Exa → Firecrawl`, with each failure cause; an empty CSS selection is
valid. Explicit `ax` never shares the URL with a provider. Exa reads use the same
access policy as search; no reader uploads local documents. Article IDs from
Mistral search results open with Mistral.

A selector requires `mode: "extract"`. Follow returned extraction offsets or
outline continuation notes. Markdown rejects nonzero offsets. When a hard output
cap is reached, narrow the selector and retry the same offset; continuation is
withheld to avoid skipping unread text. Pages can change between reads.
Selection completion does not establish whole-page completeness.

`web_read.max_age_hours` uses the search range but requires `reader: "exa"` and
a key. Keyless reads have no freshness parameter. Remote excerpts may be
cached or incomplete, especially for PDF tables and images.

## Configuration

| Environment | Purpose |
|---|---|
| `EXA_API_KEY` | Paid fallback after free-tier rejections; required for deep search and freshness reads |
| `PI_EXA_ACCESS` | `keyless` or `api-key` forces one Exa access mode; default is keyless first |
| `FIRECRAWL_API_KEY` | Firecrawl search fallback and page reading |
| `MISTRAL_API_KEY` | Mistral search and page reading when Pi's `mistral` provider has no key in `models.json` |
| `PI_WEB_SEARCH_PROVIDER` | `exa`, `firecrawl`, or `mistral` to try first when `provider` is omitted; skipped when unconfigured or incompatible |
| `PI_WEB_OPEN_PROVIDER` | `exa`, `firecrawl`, or `mistral` to try first in the remote reading chain |

Public access has provider-controlled rate limits; keyed requests may incur
charges, and a key is spent only when the free tier rejects a request. The extension
cannot inspect balances or enforce spending caps. Mistral uses the key and API root of Pi's `mistral` provider;
connector searches may incur charges and provider retention policies apply. Keys are read from Pi's environment,
not project `.env` files, and are not persisted.

For local reading, install [ax](https://ax.yusuke.run/) separately on Pi's PATH.
Tested with ax 0.1.25; see its [manual](https://ax.yusuke.run/llms.txt) for flags.
Local reads need no search key.

Provider references: [Exa MCP](https://exa.ai/docs/get-started/exa-mcp),
[Exa search](https://exa.ai/docs/reference/search),
[Exa contents](https://exa.ai/docs/reference/get-contents),
[Firecrawl search](https://docs.firecrawl.dev/api-reference/endpoint/search),
[Mistral web search](https://docs.mistral.ai/studio/agents/agent-tools/websearch).

## Dependencies and limitations

- Uses public Pi APIs, host TypeBox, and Node.js built-ins; no runtime npm packages.
  Cross-platform with outbound HTTPS and, for local reading, a compatible ax binary.
- Search timeouts: 30 seconds, or 60 seconds for deep Exa. Responses are
  capped at 2 MB; redirects are rejected. Keyless MCP sends only the query/options,
  with short-lived connections and cancellation cleanup capped at 1.5 seconds.
- Exa retries HTTP 429 after 1, 2, 4, 8, 16, and 32 seconds plus up to 0.5 s of
  jitter, or after `Retry-After` when given, only while the wait fits the
  remaining deadline; keyless access also retries 502/503/504. A free-tier 429
  switches to the key instead of waiting when one is set. Network failures,
  timeouts, authentication/protocol errors, and account 5xx errors are not
  replayed. Other providers are not retried. Server-side cancellation and billing
  remain provider-controlled.
- Local reads use 25-second network and 30-second process limits, a 2 MB download
  cap, no ax disk cache, and a separate 40,000-character output cap.
- ax accepts no credentials or custom headers, does not render JavaScript or
  bypass logins, and may follow redirects using the machine's network access.
  It is not a network sandbox. No reader guarantees access or complete extraction.
- Tests use provider fixtures. Live checks covered ax and keyless Exa;
  direct keyed/paid calls remain unverified.
