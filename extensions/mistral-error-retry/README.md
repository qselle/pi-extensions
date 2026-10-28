# mistral-error-retry

Auto-retries Mistral turns that fail with `Provider stopped with: error`.

Pi 1.0's Mistral adapter reports this when a stream ends with
`finish_reason: "error"`: the model server aborted generation without a reason.
Retrying usually works, but Pi's auto-retry does not recognize the wording, so
the turn stops. Since Pi 1.1, the adapter reports
`Provider stopped with: error (server error)` itself and Pi retries it, so this
extension has nothing to rewrite there.

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

- Only takes effect on Pi 1.0.4–1.0.x with auto-retry enabled (`retry.enabled`,
  on by default); `retry.maxRetries` and backoff settings still apply. On Pi 1.1
  and newer, Pi's own retry handles these errors without the three-failure cap.
- Matches the exact error text of Pi's Mistral adapter; other wording is untouched.
- No configuration, network access, or third-party packages.
