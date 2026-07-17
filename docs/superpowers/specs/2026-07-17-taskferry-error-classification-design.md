# Taskferry Error Classification, Failure Detail, and Resume Hints Design

## Goal

Replace the single ad hoc `provider_usage_exhausted` failure bucket with
three narrower, correctly-named ones; add a `failureDetail` field that
explains *why* a crash bucket fired, not just which one; and make a crashed
task's `next` hint tell the caller how to resume it when a session is
salvageable, regardless of which bucket crashed it.

## Background

`src/tasks.js`'s watchdog already classifies two failure modes into
`task.failureReason`:

- `no_output_timeout`: the log stops growing entirely for the configured
  deadline (`failRunningTask(current, "no_output_timeout")`).
- `provider_usage_exhausted`: a `type:"error"` event or raw non-JSON log
  line matches `PROVIDER_EXHAUSTION_PATTERNS`, scoped away from the model's
  own narration text on purpose (GLM-5.2 review of 0d944df..4e75129, finding
  1: scanning raw narration for these words false-positived on healthy
  output that merely *discussed* rate limits).

`PROVIDER_EXHAUSTION_PATTERNS` today bundles two different provider
failures under one name:

```js
const PROVIDER_EXHAUSTION_PATTERNS = [
  /rate.?limit/i,
  /\bquota\b/i,
  /usage.?limit/i,
  /too many requests/i,
  /\b429\b/i,
  /insufficient_quota/i,
];
```

`failureReason` is surfaced today only via `--full` (`status`/`wait`/`result
--full`); `docs/cli-reference.md` documents it as `null` unless
`no_output_timeout` or `provider_usage_exhausted`. There is no field today
that explains *what specifically* was seen: a caller gets the bucket name
and nothing else. Two items dropped from the original five-item VR sweep
after review: final marker validation (no driving incident: the `Status:`
marker contract is a prompt convention, not something the daemon has reason
to enforce) and empty message handling (the real incident behind it was
complete silence, already caught by `no_output_timeout`; a task that runs to
completion with tool calls but a blank final message isn't a case that's
actually occurred).

`leanStatus` (`src/output.js`) computes a `next` hint for every non-running
status. For `crashed`, it's the same generic "run `taskferry result`" text
regardless of failure reason or whether the task's session is salvageable.

## Behavior

### Bucket split: `rate_limited`, `payment_required`, `authentication_failed`

`PROVIDER_EXHAUSTION_PATTERNS` and the single `provider_usage_exhausted`
bucket are removed. Three pattern lists and three `failureReason` values
replace them:

```js
const RATE_LIMITED_PATTERNS = [
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /\b429\b/i,
];
const PAYMENT_REQUIRED_PATTERNS = [
  /\bquota\b/i,
  /insufficient_quota/i,
];
const AUTHENTICATION_FAILED_PATTERNS = [
  /\b401\b/,
  /unauthorized/i,
  /invalid.api.?key/i,
  /authentication.?failed/i,
];
```

The existing `detectProviderExhaustion` scanning mechanism is unchanged
(same `type:"error"`-event / raw-non-JSON-line scoping, same
carry-buffer handling in the watchdog interval): only the pattern-to-bucket
mapping changes. The watchdog interval in `startRunningWatcher` tries each
bucket's patterns against the same `lines`/`carry` text it already extracts,
in the order rate_limited → payment_required → authentication_failed (first
match wins; a line is very unlikely to match more than one bucket given how
distinct the pattern sets are, so ordering only matters as a defined
tie-break), and calls `failRunningTask(current, <bucket>)` for whichever
bucket matched, capturing the matched line for `failureDetail` (below) at
the same call site.

`no_output_timeout` detection and its `failureReason` value are unchanged.

### `failureDetail` field

New `Task` property, `string|null`, alongside `failureReason`. Set at the
same call site that sets `failureReason` (`failRunningTask`'s callers in the
watchdog interval), never mutated afterward: same lifecycle as
`failureReason` itself (`failRunningTask` already guards against
overwriting a `failureReason` that's already set; `failureDetail` is set in
that same guarded call, so it inherits the same "first crash wins" rule).

Content by bucket:

- `rate_limited` / `payment_required` / `authentication_failed`: the exact
  log line (or `type:"error"` event's `message`) that matched, trimmed to a
  reasonable length (reuse whatever truncation convention `outputTail`
  already uses, if one exists, else cap at 500 chars) so a large log line
  doesn't blow up the status payload.
- `no_output_timeout`: which timeout value fired, e.g. `"no output for
  120000ms (post-output timeout)"` or `"no output for 60000ms (pre-output
  timeout)"` depending on whether `outputSeen` had already latched: this
  distinguishes a stall before the task ever produced output from one after,
  which is diagnostically useful for tuning `--no-output-timeout-ms` /
  `--post-output-no-output-timeout-ms`.
- Any other crash path (non-zero exit with no watchdog-set failureReason,
  `spawnError`, `cancelled`): stays `null`. This design only adds
  `failureDetail` where a `failureReason` bucket already exists; it does not
  add new detection for other crash shapes.

`failureDetail` is surfaced the same way `failureReason` already is: `--full`
only (`status --full`, `wait --full`, `result --full`, wherever
`failureReason` appears in `summarize()`'s output today, `failureDetail`
appears alongside it). No change to the lean (non-`--full`) projection.

### Resume hints in `next`

`leanStatus` (`src/output.js`) receives the full `detail` object (including
`sessionId`, even though lean output doesn't expose `sessionId` as its own
top-level field) before trimming it down. Its `next`-hint computation for
`status === "crashed"` changes: when `detail.sessionId` is present, the hint
includes the resume command; when absent, it falls back to today's generic
text.

```js
lean.next = status === "running" || status === "queued"
  ? `Run taskferry wait or taskferry status with task id "${id}" to check progress; pass --full for directory/model/log path details`
  : status === "crashed" && detail.sessionId
    ? `Session "${detail.sessionId}" may be salvageable; resume with taskferry dispatch --session-id "${detail.sessionId}" --directory "${detail.directory}" --prompt "<continuation prompt>"`
    : `Run taskferry result with task id "${id}" to see the final message; pass --full here for directory/model/log path details`;
```

This applies to a `crashed` task with a salvageable session regardless of
which `failureReason` bucket fired: a `rate_limited` or
`payment_required` crash is exactly the case where resuming once the limit
clears is the whole point, so scoping the hint to `no_output_timeout` alone
(the todo item's original wording) would leave out the buckets where it
matters most.

`directory` must already be present on `detail` for this branch to render a
complete command; `summarize()` (`src/tasks.js`) already includes
`directory` unconditionally, so this holds for every caller of `leanStatus`.

## What this does not change

- `no_output_timeout` detection, timing, and latch behavior in the watchdog
  interval (`src/tasks.js`'s `startRunningWatcher`): only what gets
  recorded alongside it via `failureDetail`.
- The `detectProviderExhaustion`-style scoping to `type:"error"` events and
  raw non-JSON lines only, never narration text.
- `status`, `result`, `tail`, `summary`, `watch`, `wait --summarize`: none
  of these commands' shapes change beyond the new `failureDetail` field
  riding alongside `failureReason` wherever that already appears, and the
  `next`-hint text change in `leanStatus`.
- Final marker validation and empty message handling are out of scope for
  this design (see Background).

## Testing

- `detectProviderExhaustion`-equivalent bucket matching: each of the three
  pattern lists matches its intended sample lines and does not cross-match
  another bucket's samples; narration-only `type:"text"` events are still
  never scanned.
- `failureDetail` content: matched-line capture for each of the three
  pattern buckets; timeout-value message for `no_output_timeout` in both the
  pre-output and post-output latch states; stays `null` for crashes with no
  watchdog-set `failureReason`.
- `failureDetail`/`failureReason` "first crash wins": a second watchdog tick
  after `failureReason` is already set does not overwrite either field.
- `leanStatus` `next` hint: crashed + `sessionId` present → resume command
  text with correct `sessionId`/`directory`; crashed + no `sessionId` →
  unchanged generic text; running/queued/done paths unchanged.
- `docs/cli-reference.md`'s `status` section: bucket list and `failureDetail`
  description updated to match.
