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

Nothing in `src/` (outside `tasks.js` itself) or `skills/taskferry/SKILL.md`
pattern-matches the literal string `"provider_usage_exhausted"`: it's read
by a human or agent from CLI/RPC output, never branched on by taskferry's
own code. Removing it is not a silent loss of caller-visible information:
today a caller sees "some provider-usage problem happened" and has to guess
whether waiting, adding billing, or fixing a credential is the right next
step. The three-way split answers that question directly instead of making
the caller re-derive it from a generic bucket name.

`leanStatus` (`src/output.js`) computes a `next` hint for every non-running
status. For `crashed`, it's the same generic "run `taskferry result`" text
regardless of failure reason or whether the task's session is salvageable.

## Behavior

### Bucket split: `rate_limited`, `payment_required`, `authentication_failed`

`PROVIDER_EXHAUSTION_PATTERNS` and the single `provider_usage_exhausted`
bucket are removed. Three pattern lists and three `failureReason` values
replace them, ordered most-specific-first so that real provider text
combining more than one signal (e.g. "Rate limit exceeded, check your
quota", which is common: providers routinely describe a rate limit in terms
of a quota) resolves to the bucket that actually explains the correct
remediation, not whichever pattern happens to be listed first:

```js
// Checked first: `insufficient_quota` and `payment required`/`billing`
// are unambiguous billing signals that never mean "retry later works" the
// way a rate-limit message does.
const PAYMENT_REQUIRED_PATTERNS = [
  /insufficient_quota/i,
  /payment.?required/i,
  /\bbilling\b/i,
  /status(_code)?[:\s=]+402\b/i,
];
// Checked second: `unauthorized` / `invalid api key` are unambiguous auth
// signals. The bare 401 variant requires a `status`/`status_code` prefix
// rather than matching `\b401\b` on its own: a raw non-JSON log line (the
// noisiest scanning surface `detectProviderExhaustion` covers, per the
// GLM-5.2 finding above) can contain an unrelated 3-digit number (a byte
// count, a line number, a test count) that would otherwise false-positive.
const AUTHENTICATION_FAILED_PATTERNS = [
  /unauthorized/i,
  /invalid.api.?key/i,
  /authentication.?failed/i,
  /status(_code)?[:\s=]+401\b/i,
];
// Checked last: the broadest, most generic bucket. Bare `quota` (without
// `insufficient_quota` or another payment_required signal) lands here
// deliberately: providers use "quota" for rate/usage budgets far more
// often than for billing failures, so an ambiguous bare mention defaults
// to the safer "transient, retry later" interpretation rather than the
// "needs a billing fix" one.
const RATE_LIMITED_PATTERNS = [
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /\b429\b/i,
  /\bquota\b/i,
];
```

The existing `detectProviderExhaustion` scanning mechanism is unchanged
(same `type:"error"`-event / raw-non-JSON-line scoping, same carry-buffer
handling in the watchdog interval): only the pattern-to-bucket mapping
changes. The watchdog interval in `startRunningWatcher` tries each bucket's
patterns against the same `lines`/`carry` text it already extracts, in the
fixed order payment_required → authentication_failed → rate_limited (first
match wins), and calls `failRunningTask(current, <bucket>)` for whichever
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
  log line (or `type:"error"` event's `message`) that matched, capped at 500
  characters (`+ "…"` if longer) so a large log line doesn't blow up the
  status payload. There's no existing truncation convention to reuse here:
  `outputTail`'s truncation is driven by a caller-supplied `tailChars`
  parameter (`output.slice(-tailChars)`), not a fixed internal cap, so 500
  is a new, self-contained constant for this field specifically.
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

#### Surfacing: two call sites, one shared helper

`failureReason` is duplicated across two independent object literals today:
`summarize()` (`src/tasks.js:576`, backs `task.status`/`task.wait`) and
`result()` (`src/tasks.js:~1680`, backs `task.result`) each hand-list their
own field set, and each has to remember `failureReason: task.failureReason
?? null` separately. Adding `failureDetail` the same way would double that
duplication (four independent edit sites instead of two) and makes it easy
for a future field to land in one projection and not the other. Instead,
extract a small shared helper both call sites spread in:

```js
/** @param {Task} task */
function failureFields(task) {
  return { failureReason: task.failureReason ?? null, failureDetail: task.failureDetail ?? null };
}
```

`summarize()` and `result()` each replace their own `failureReason:
task.failureReason ?? null,` line with `...failureFields(task),`. This is
the only change to either function's structure; every other field stays as
hand-listed as it is today (the two functions still return genuinely
different shapes (`summarize()` has `directory`/`model`/`pid` that
`result()` doesn't, `result()` has `narration`/`tokens`/`cost` that
`summarize()` doesn't), so a full unification isn't appropriate, just the
one field pair that both need to stay in lockstep).

`RESULT_FIELDS` (`src/tasks.js:135`, the `Set` gating `task.result`'s
`--fields` allow-list) gains `"failureDetail"`. The hardcoded `--fields`
error-help text (`tasks.js:1610`, currently `"use message, narration,
tokens, cost, sessionId, exitCode, signal, spawnError, failureReason,
keySlot, or logPath"`) is itself a hand-duplicated copy of `RESULT_FIELDS`'
contents that has to be kept in sync by hand today: replace it with a
message generated from the `Set` itself (`` `use one of: ${[...RESULT_FIELDS].join(", ")}` ``
or similar), so adding `failureDetail` to `RESULT_FIELDS` updates the help
text automatically instead of requiring a second hand-edit that's easy to
forget, as it would have been for this exact field.

`failureDetail` is surfaced the same way `failureReason` already is: `--full`
only (`status --full`, `wait --full`, `result --full`), and via `--fields
failureDetail` on `result`. No change to the lean (non-`--full`)
projection.

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

## Documentation

Three doc files mention `provider_usage_exhausted` today and would go stale
if only `docs/cli-reference.md` were updated:

- `docs/daemon.md`'s "Watchdogs" section: the technical reference for the
  watchdog mechanism (timeouts, poll interval, what triggers each bucket).
- `docs/troubleshooting.md`: a "task is stuck crashed with failureReason:
  X" runbook entry per failure reason, giving the human/agent reading it a
  concrete next action.
- `docs/cli-reference.md`'s `status` section: the one-line summary of what
  `failureReason` values mean, already noted above.

These aren't accidental duplication: `daemon.md` documents *how the
watchdog decides*, `troubleshooting.md` documents *what to do about it*,
and they already follow this split for `no_output_timeout` today. But the
current `provider_usage_exhausted` entries duplicate the actual pattern
list (rate limit/quota/429) in both files, which is the part that would
need updating twice if a pattern ever changes. Reduce that surface instead
of tripling it for three buckets:

- `daemon.md` stays the single place that lists what each bucket actually
  matches (updated to the three new buckets and their `PAYMENT_REQUIRED_`
  / `AUTHENTICATION_FAILED_` / `RATE_LIMITED_PATTERNS` intent, in prose, not
  the regexes themselves).
- `troubleshooting.md`'s single `provider_usage_exhausted` entry becomes
  one entry covering all three buckets (not three separate near-duplicate
  entries), giving per-bucket remediation advice (`rate_limited`: retry
  later or switch key-slot; `payment_required`: fix billing on that
  key-slot's account or switch key-slot; `authentication_failed`: the
  credential in that key-slot is broken, rotate it) and linking to
  `daemon.md`'s Watchdogs section for what specifically triggers each one,
  rather than repeating the pattern list a second time.
- `cli-reference.md`'s `status` section: the `failureReason` value list
  updated to the three new bucket names plus `no_output_timeout`, and a
  one-line mention that `--full`/`--fields failureReason` also has
  `failureDetail` alongside it.

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

- Existing `src/tasks.test.js` `describe("provider-usage-exhaustion
  detection", ...)` block (4 tests, all asserting `failureReason ===
  "provider_usage_exhausted"`) is rewritten, not left in place: its
  `"rate_limit_exceeded: please retry after 60s"` and `"rate limit
  exceeded"` sample text both belong under `rate_limited` in the new split,
  so those tests get renamed/re-asserted, not duplicated.
- Bucket matching, one test per bucket's intended sample lines, confirming
  no cross-match into either of the other two buckets; narration-only
  `type:"text"` events are still never scanned.
- Collision resolution (the scenario that motivated the most-specific-first
  ordering): a line containing both a rate-limit phrase and the word
  `quota` (no `insufficient_quota`) resolves to `rate_limited`; a line
  containing both `insufficient_quota` and a rate-limit phrase resolves to
  `payment_required` (checked first).
- `authentication_failed`'s tightened 401 pattern: a raw non-JSON line
  containing an unrelated 3-digit number in a `status`/`status_code`-free
  context (e.g. `"401 tests passed"`) does not match; `"status_code: 401"`
  and `"unauthorized"` both do.
- `failureDetail` content: matched-line capture (capped at 500 chars) for
  each of the three pattern buckets; timeout-value message for
  `no_output_timeout` in both the pre-output and post-output latch states;
  stays `null` for crashes with no watchdog-set `failureReason`.
- `failureDetail`/`failureReason` "first crash wins": a second watchdog tick
  after `failureReason` is already set does not overwrite either field.
- `failureFields()` helper: both `summarize()` and `result()` output include
  `failureReason`/`failureDetail` via the shared helper, not a hand-copied
  literal.
- `result --fields failureDetail` returns the field; the `--fields` error
  message (invalid field name) reflects `RESULT_FIELDS`' actual contents,
  including `failureDetail`, without a second hardcoded list to fall out of
  sync.
- `leanStatus` `next` hint: crashed + `sessionId` present → resume command
  text with correct `sessionId`/`directory`; crashed + no `sessionId` →
  unchanged generic text; running/queued/done paths unchanged.
- `docs/cli-reference.md`'s `status` section, `docs/daemon.md`'s
  "Watchdogs" section, and `docs/troubleshooting.md`'s (now-consolidated)
  provider-failure entry all updated to match; see Documentation above.
