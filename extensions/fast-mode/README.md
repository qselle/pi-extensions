# fast-mode

Explicitly request premium fast processing for the current model through Pi's public request hook. Disabled by default; never silently carries across models or sessions.

## Usage

```text
/fast on      Request fast processing for the current model
/fast off     Remove this override; provider/project defaults apply
/fast status  Show whether the override is enabled
```

Enabling displays `fast: requested` in the status area. The next matching main-agent request uses `service_tier: "priority"`. This overrides an existing tier field while enabled. Model selection, session start, branch navigation and shutdown clear the setting. It is not persisted to disk.

OpenAI documents `priority` as an alias for fast processing on supported models. Fast processing has premium pricing, eligibility restrictions and possible fallback to standard service; requesting it does not prove it was delivered. See the [official Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode).

With ChatGPT-authenticated Codex, fast mode can increase credit consumption. API
pricing and ChatGPT credit accounting are different; see the [official speed
guide](https://learn.chatgpt.com/docs/agent-configuration/speed). No credit purchase
or account setting is changed by this extension.

## Dependencies and limitations

- Uses Pi's public extension request, model and status APIs; no third-party packages.
- Supports the `openai` provider with `openai-responses` at `https://api.openai.com/v1`, plus `openai-codex` with `openai-codex-responses` at `https://chatgpt.com/backend-api` (also accepting its `/codex` and `/codex/responses` forms). Fine-tuned models, custom proxies, Chat Completions and other providers are not supported by this implementation.
- The gate verifies protocol and endpoint, not account eligibility or each model's tier availability. Provider errors are surfaced normally; no paid retry or automatic fallback is added.
- Changes apply to future requests, not a request already in flight. Independent side-chat/title calls and child processes do not inherit this override.
- Status means requested, not confirmed. The public response hook does not expose the response body tier for independent verification. Pi's recorded cost estimates remain adapter-dependent; use provider billing for authoritative costs.
- Turning this override off does not force standard pricing if the API project itself defaults to fast processing.
- Cross-platform. Unit tests and a native Codex adapter test use no network calls. The adapter test verifies the serialized tier through an injected SSE transport; live paid-provider validation remains outstanding.
