# fast-mode

Explicitly request premium fast processing for OpenAI models through Pi's public request hook. Off by default; the choice is saved.

## Usage

```text
/fast on      Request fast processing for eligible models
/fast off     Stop requesting it; provider/project defaults apply
/fast status  Explain the saved state and the current model's behavior
```

While enabled, main-agent requests for an eligible model use `service_tier: "priority"`, overriding an existing tier field. The `footer` extension shows a `fast` badge beside the model. Models from other providers show no badge and their requests are unchanged.

The choice persists in `$PI_CODING_AGENT_DIR/fast-mode.json` (defaults to `~/.pi/agent/fast-mode.json`) and applies to every session and model until `/fast off`. If the file cannot be written, the choice lasts for the current runtime and a warning says so.

Eligibility depends on the protocol, not an endpoint or model allowlist, so new model IDs and custom base URLs work without an update. The API decides whether it accepts priority. When it explicitly rejects the tier (for example `Unknown parameter: 'service_tier'`), the badge shows `fast unavailable` and a warning appears. The original error is unchanged and no fallback request is sent. Ordinary errors such as rate limits and timeouts do not change the badge. The next request still asks for priority and restores `fast`; switching models or sessions clears the rejection.

OpenAI documents `priority` as an alias for fast processing on supported models. Fast processing has premium pricing, eligibility restrictions and possible fallback to standard service; requesting it does not prove it was delivered. See the [official Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode).

With ChatGPT-authenticated Codex, fast mode can increase credit consumption. API
pricing and ChatGPT credit accounting are different; see the [official speed
guide](https://learn.chatgpt.com/docs/agent-configuration/speed). No credit purchase
or account setting is changed by this extension.

## Dependencies and limitations

- Uses Pi's public extension request, model, message and event-bus APIs; no third-party packages. The badge needs the `footer` extension; without it, use `/fast status`.
- Eligible protocols: `openai` with `openai-responses` and `openai-codex` with `openai-codex-responses`. Chat Completions and other providers are left unchanged.
- Changes apply to future requests, not a request already in flight. Independent side-chat/title calls and child processes do not inherit this override.
- The badge means requested, not confirmed. The public response hook does not expose the response body tier for independent verification. Pi's recorded cost estimates remain adapter-dependent; use provider billing for authoritative costs.
- Turning this override off does not force standard pricing if the API project itself defaults to fast processing.
- Cross-platform. Tests use an injected transport; live paid-provider behavior is unverified.
