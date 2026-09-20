# web-search

Web research tools with compact source previews, explicit provider attribution,
bounded snippets, and local, remote, or explicit local-first page reading.

## Usage

- `web_search`: query, optional provider (`exa`, `firecrawl`, or `mistral`), limit (1–10), and
  domain filters (hostnames, subdomains, and optional path prefixes). Returned URLs are checked
  locally against those filters, even if the provider ignores them. Defaults to
  **Exa without a key**, using its free, rate-limited hosted search. Set `PI_EXA_ACCESS=api-key` together with
  `EXA_API_KEY` to use the direct API. A key alone does not change the default. Firecrawl and Mistral
  require explicit provider selection and their own keys; their presence never
  changes the default. Failures never switch access paths or providers. One bounded retry is allowed for explicit rate-limit rejection (details below).
- Optional `quality`: `balanced` (default), `fast`, or `deep`. Exa maps these to
  `auto`, `fast`, and `deep`; Firecrawl supports balanced only. Fast/deep select
  Exa when provider is omitted. Keyless Exa supports balanced and fast; deep
  requires `PI_EXA_ACCESS=api-key` and `EXA_API_KEY`. An explicit incompatible
  provider fails before any request, without silently changing providers.
- Deep searches optionally accept `additional_queries`: 1–5 query variations,
  each up to 500 characters. Results remain bounded source snippets; open the
  sources for verification. Deep mode may take longer and incur higher charges.
- Optional `web_search.date_range` accepts `{ "start": "2024-01-01", "end": "2024-01-31" }`.
  At least one bound is required; supplied bounds must be valid `YYYY-MM-DD` dates in order. Exa receives publication
  timestamps spanning those UTC days; Firecrawl receives its calendar date filter.
  Results show the requested window, not a claim of independently verified dates.
- Optional Exa `max_age_hours` controls content retrieval freshness: `0` requests
  a fresh fetch, `-1` uses cached content only, and `1`–`720` allows that many hours
  of cache age. Omit it for provider defaults. This is separate from publication
  dates and is shown as a requested policy, not verified freshness. Other search
  providers reject it before sending a request.
- `web_read`: HTTP(S) URL, reader (`ax`, `exa`, or explicit `auto` fallback), mode
  (`markdown`, `outline`, or CSS `extract`), optional selector, token budget
  (100–8000, default 2000), and continuation offset.
- `/web`: reports the default Exa access path and explicitly configured alternative
  providers without exposing keys. This is a configuration check, not a
  connectivity or billing test.

Search previews show up to three sources, reserving room for each hostname even
when its title is long. Very narrow views prioritize the hostname; shortened
hostnames have an ellipsis. Hostnames link to their source on terminals supporting
OSC 8, using the shared `/hyperlinks` mode when that extension is enabled. Expand
to view all full source URLs and snippets. Exclusion counts distinguish invalid URLs, duplicate pages,
out-of-domain results and rows beyond the requested limit. An empty provider
response is distinguished from a response with no usable results remaining.
Rejected URL contents are not shown. Read previews distinguish extraction
continuation, selection completion, and unverified completeness. Continuation
offsets appear first so they remain visible in narrow views. Hard output truncation
takes precedence over completion metadata. Expand for page content and ax's notes. Search snippets and page content are untrusted data, not instructions.
Open sources to verify claims and cite the actual source URLs.
Empty previews distinguish no matches, excluded results, and missing Mistral
citations. Failures show a bounded cause with full details available on expansion.
Firecrawl warnings remain visible even on successful responses: compact cards
flag the warning, and expanded output includes its bounded text as untrusted
provider data. An empty response with a warning is not reported as proof that no
matches exist. A warning never triggers another request automatically.

`domains` and `exclude_domains` accept up to ten hostnames or path prefixes each,
for example `docs.example.com/API`. Paths retain their case and match whole path
segments: `/API` includes `/API/guide`, but not `/APIs` or `/api`. Subdomains are
included; lookalike hostname suffixes are not. Protocols, credentials, ports,
queries and fragments are rejected. Exa receives the full filters; Firecrawl
receives host hints and Mistral receives source preferences. Every provider's
returned URLs are checked locally, with exclusion counts visible. Filtering can
leave fewer results than the requested limit. The extension does not refill the
list with extra provider calls. Tracking variants (`utm_*`, `fbclid`, `gclid`,
`dclid`, `msclkid`) and fragments do not consume multiple result slots; distinct
content query parameters remain distinct and citation URLs are preserved.

Optional Exa `category` selects `news`, `pdf`, `github`, `publication`, `company`,
`people`, `personal site`, or `financial report`; these are provider-assigned
categories or hints. Unsupported combinations fail before any request:
`publication` with domain filters, or `company`/`people` with publication dates or
excluded domains. To preserve those constraints, omit the category and express
the source type in the query. Filters are never silently dropped.

For current documentation under a specific path:

```json
{
  "query": "TaskGroup cancellation",
  "domains": ["docs.python.org/3/library"],
  "exclude_domains": ["docs.python.org/3/library/asyncio-policy.html"],
  "max_age_hours": 24
}
```

`web_read` defaults to local-only `ax`. Select `reader: "auto"` to try ax first
and, after an ax process/transport failure, empty text, or a recognized short
access challenge, retry the same public URL once through Exa. The two attempts
share a 45-second deadline. Auto fallback is limited to Markdown reads without selectors or
continuation; invalid input, cancellation, structured extraction, and outline
failures never trigger it. The result identifies both readers and retains a
sanitized local failure reason. If both attempts fail, the error retains the
local cause and any remote HTTP status without copying arbitrary error text.
Empty CSS selections remain valid and never cause a remote fallback. Challenge
detection recognizes whole short messages such as “Just a moment…”; an article
discussing access errors is still readable. It does not attempt to classify every
login page or poor extraction.

Select `reader: "exa"` to go remote immediately for PDFs or sources that reject a
direct client; access is not guaranteed. Both remote modes use the same Exa access setting as search, which may be
account-backed only when deliberately configured.

The tool never uploads local documents. Explicit `reader: "ax"` (and the default)
never shares the URL with Exa. When ax reports an HTTP rejection, errors retain
only the sanitized status code (for example, HTTP 401); arbitrary stderr is not
copied into model context. Remote reads support bounded excerpts only, without CSS
selectors, outlines or continuation. Account responses retain the provider-reported
source URL; keyless MCP prose is not promoted to verified redirect metadata. PDF
tables, images and text may be incomplete, and cached content may be stale.
Both readers reject empty or recognized challenge-only broad reads instead of
reporting those as page content. A selector requires `mode: "extract"`.

`web_read.max_age_hours` uses the same range as search, but requires explicit
`reader: "exa"` and API-key access. The keyless fetch tool has no freshness
parameter and rejects this option; use ax for a direct fetch instead. The account
mapping follows the [Exa contents API](https://exa.ai/docs/reference/get-contents).

## Configuration

No setup is needed for keyless Exa search. It uses Exa's documented
[hosted MCP service](https://exa.ai/docs/get-started/exa-mcp), with no sign-in or
local MCP server. Free anonymous access has provider-controlled rate limits;
there is no promise of unlimited searches or a fixed quota.

Optionally set both `PI_EXA_ACCESS=api-key` and `EXA_API_KEY` in Pi's environment
for direct API access, including deep mode. `PI_EXA_ACCESS=keyless` is the default. Exa offers account credits on its [free plan](https://exa.ai/pricing);
the extension cannot inspect your balance, enforce a free-tier spending cap or
guarantee that keyed requests are free. Nothing configures billing automatically.
Account access is never a fallback for keyless rate limits. A rejected configured key is reported rather than
silently using anonymous access.

Set `FIRECRAWL_API_KEY` only if selecting Firecrawl explicitly. The extension does
not read project `.env` files or persist keys. Direct API search uses the documented
[Exa search API](https://exa.ai/docs/reference/search) and
[Firecrawl v2 search API](https://docs.firecrawl.dev/api-reference/endpoint/search).
Requests may incur provider charges. Date windows follow the Exa publication-date
fields and [Firecrawl time filters](https://docs.firecrawl.dev/features/search).
Provider date matching can differ; open the sources to verify publication dates.
Undated results remain visible rather than being assigned an invented date.

Optional Mistral search uses `MISTRAL_API_KEY` and the documented
[Conversations web-search tool](https://docs.mistral.ai/studio/agents/agent-tools/websearch)
with `mistral-medium-latest`. It sends only the query and source-selection
instructions, requests `store: false`, and creates no reusable agent. The request
can incur both model and search-tool charges; provider retention policies still
apply. It uses balanced mode only and rejects date windows before sending.
Domain preferences are supplied to the model and enforced locally on returned URLs.

Mistral results are model-selected web citations, not a raw ranked search list.
Only `web_search` reference chunks are returned. Generated answer text and links
appearing only in prose are discarded; descriptions are citation metadata, not
verified quotes. No citations does not establish that no web matches exist.
`/web` and `/doctor` report Mistral key presence without making a paid call.

For page reading, install [ax](https://ax.yusuke.run/) separately and ensure `ax`
is on Pi's PATH. Use a version supporting the flags in its
[current manual](https://ax.yusuke.run/llms.txt). Nothing is installed automatically.
ax is an HTTP/HTML extractor, not a search index. Page reads need no search key.

Validated against installed ax **0.1.25** with live GET requests to its public documentation site. Extraction uses `--row text= --json-envelope` and reports `more`, `complete`, or `past_end` with an exact continuation offset. Markdown is a bounded excerpt and rejects nonzero offsets: ax does not support structured Markdown continuation. Outline mode retains ax's stderr continuation notes; its completeness is not machine-verified.

Retries share the original deadline. Exa gets at most one retry after HTTP 429;
keyless access also permits one retry after 502/503/504. A `Retry-After` delay over
two seconds is surfaced without waiting. Network exceptions, timeouts, protocol
errors, authentication failures and account 5xx errors are never replayed.
This avoids replaying account requests whose execution is uncertain. Other
providers are not retried. No retry changes providers, keys or access policy.

## Dependencies and limitations

- Search/page results use the same compact transcript background as native tool
  overrides. Source rows show full clickable URLs and dates at normal widths,
  prioritize the origin in narrow terminals, and show your configured expansion
  key. Bounded error causes wrap instead of hiding their final words.

- Known publication dates outside a requested window are rejected locally in both
  keyless and account-backed results. Unknown dates and overlapping partial dates
  are retained with an explicit unverified-date label; verify dates on sources.

- Pi public tools/renderers and host TypeBox; Node.js built-ins and shared helpers in `lib/`; no runtime npm packages. Enabling `hyperlinks` is optional.
- Search works cross-platform with outbound HTTPS. The optional page reader
  requires a compatible ax binary for the operating system.
- Keyless Exa uses a short-lived MCP connection to the fixed hosted endpoint and
  `web_search_advanced_exa` for structured sources, bounded highlights, and
  domain/date controls. It sends only the supplied query and search options, with
  no session transcript, workspace files or account credentials. MCP initialization
  is followed by a search or explicit fetch; JSON and SSE responses are supported. Responses
  are parsed as structured data, never by guessing URLs from generated prose.
- Cancellation stops waiting and attempts an MCP cancellation notification;
  assigned sessions are released with cleanup bounded to an additional 1.5 seconds. Server-side
  cancellation remains provider-controlled. Connections are not kept open or restarted after protocol errors, and no local listener or additional package is required.
- Search requests time out after 30 seconds (60 seconds for deep mode or Mistral) and responses are capped at 2 MB.
  Redirects are rejected so search credentials stay at the provider endpoint.
  Firecrawl is asked to finish within 25 seconds, leaving time inside the client
  deadline for transport and response processing. Server cancellation and billing
  are controlled by the provider.
- Requested search mode appears in compact previews and expanded provenance.
  It identifies the requested provider mode, not an independently measured
  quality score. Provider-generated synthesis is not used as verified evidence.
- Local ax page reads use argument-vector execution, 25-second network / 30-second process
  limits, a 2 MB download cap, and no ax disk cache. Output has a separate 40,000
  character cap because ax permits one oversized item beyond its token budget.
- Follow extraction metadata or outline stderr continuation notes with `offset`; for a hard character cap,
  narrow the CSS selector and repeat at the same offset. Capped selections withhold
  continuation metadata and stderr hints so unread text is not silently skipped.
  Remote excerpts that reach their character budget are marked as capped even
  when the provider truncates them before returning. With caching disabled, a changing page may shift offsets. Non-advancing
  extraction offsets are rejected rather than inviting a repeated-read loop.
- Local ax page reads are GET-only and accept no credentials or custom headers. They do
  not render JavaScript, bypass logins, or guarantee extraction from every site.
- ax can follow redirects and uses the local machine's network access. This is
  not a network sandbox; use it for user-authorized URLs. Redirect destinations
  and completeness notes are reported by ax where available.
- Automated tests use deterministic provider fixtures. Live ax validation covered
  Markdown, outline, extraction, and distinct extraction pages at returned offsets.
  Live keyless Exa validation on 2026-09-20 returned ax's official documentation
  in balanced mode and Exa sources in fast mode with a domain/date window. These
  checks also exercised a documentation path filter plus `max_age_hours: 24`,
  returning three sources under the requested path, and a capped keyless page read.
  The public MCP schema was checked for category and freshness support. These
  checks verify request contracts and source handling. Direct keyed/paid API calls were not exercised and are not part
  of the test suite.
