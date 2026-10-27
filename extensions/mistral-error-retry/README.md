# mistral-error-retry

Auto-retries Mistral turns that fail with `Provider stopped with: error`.

Pi's Mistral adapter reports this when a stream ends with
`finish_reason: "error"`: the model server aborted generation without a reason.
Retrying usually works, but Pi's auto-retry does not recognize the wording, so
the turn stops.

## Usage

Enable the extension; it has no commands. When an assistant message ends with
exactly that error, the extension rewrites it to
`Provider stopped with: error (server error)`. Pi's built-in auto-retry then
handles the turn with its usual backoff, status rows, and cancel key. Other
errors, such as `content_filter` or `length`, still fail immediately.

At most 3 consecutive failures are marked retryable, so an endpoint that always
fails cannot use the whole `retry.maxRetries` budget. A successful response or a
new prompt resets the count.

## Dependencies and limitations

- Requires Pi 1.x with auto-retry enabled (`retry.enabled`, on by default);
  `retry.maxRetries` and backoff settings still apply.
- Matches the exact error text of Pi's Mistral adapter; other wording is untouched.
- No configuration, network access, or third-party packages.
