# Taskferry Error Classification, Failure Detail, and Resume Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `provider_usage_exhausted` failure bucket into three correctly-named ones (`rate_limited`, `payment_required`, `authentication_failed`), add a `failureDetail` field explaining what was actually seen, and make a crashed task's `next` hint tell the caller how to resume it when a session is salvageable.

**Architecture:** `src/tasks.js`'s watchdog interval already scans a running task's log for provider-failure diagnostics via `detectProviderExhaustion` and one pattern list. This plan replaces that with three ordered pattern lists and a `classifyProviderFailure` function returning both the matched bucket and the matched text, threads a new `failureDetail` field through the two existing places `failureReason` already surfaces (`summarize()` for `status`/`wait`, `result()` for `result`) via one shared helper, and extends `leanStatus` in `src/output.js` to add a resume command to a crashed task's `next` hint when a `sessionId` is present.

**Tech Stack:** Node.js built-in `node:test`/`node:assert/strict`, no new dependencies.

## Global Constraints

- No protocol or daemon change beyond `src/tasks.js`/`src/output.js`: `src/daemon.js`, `src/protocol.js`, `src/events.js` are not touched by this plan.
- `no_output_timeout` detection, timing, and latch behavior in `startRunningWatcher` are unchanged; only what gets recorded alongside it (`failureDetail`) is new.
- `failureDetail` is surfaced the same way `failureReason` already is: `--full` only (`status --full`, `wait --full`, `result --full`), and via `--fields failureDetail` on `result`. No change to the lean (non-`--full`) projection.
- Every new/changed public field needs a passing `npm run lint` and `npm run typecheck` (JSDoc types, not TypeScript files).
- Run `npm test` after every task; do not move to the next task with a red suite.
- Final marker validation and empty message handling are explicitly out of scope for this plan (dropped during spec review; see `docs/superpowers/specs/2026-07-17-taskferry-error-classification-design.md`, Background section).

---

### Task 1: Split `provider_usage_exhausted` into three ordered buckets and capture `failureDetail`

**Files:**
- Modify: `src/tasks.js` (typedefs ~line 22-119, `PROVIDER_EXHAUSTION_PATTERNS`/`detectProviderExhaustion` at lines 138-170, task-creation object literals at lines ~685-702 and ~900-919, `failRunningTask` at lines 1154-1173, watchdog interval at lines 1224-1254)
- Modify: `src/tasks.test.js` (replace the `describe("provider-usage-exhaustion detection", ...)` block, lines 649-750)

**Interfaces:**
- Produces: `classifyProviderFailure(lines: string[]) -> {bucket: string, detail: string} | null`, where `bucket` is one of `"payment_required"`, `"authentication_failed"`, `"rate_limited"`. Replaces `detectProviderExhaustion`, which no consumer outside this file uses.
- Produces: `failRunningTask(task, failureReason, failureDetail?)`: a third parameter, backward compatible (existing two-arg calls still work since `failureDetail` defaults to `undefined` and is stored as `null`).
- Produces: `Task.failureDetail: string|null`, alongside the existing `Task.failureReason`.

- [ ] **Step 1: Write failing tests for the three buckets, collision resolution, the tightened 401 pattern, and `failureDetail` content**

Replace the entire `describe("provider-usage-exhaustion detection", ...)` block (`src/tasks.test.js:649-750`) with:

```javascript
describe("provider-failure classification", () => {
  test("a rate-limit diagnostic in the log stops the child early with failureReason rate_limited and captures failureDetail", async () => {
    const child = fakeChild(7101);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000, // long enough that only exhaustion detection could trigger this
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, "rate_limit_exceeded: please retry after 60s");
  });

  test("an unterminated rate-limit diagnostic stops the child early", async () => {
    const child = fakeChild(7104);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "rate limit exceeded");

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, "rate limit exceeded");
  });

  test("status still lands on crashed when the SIGTERM'd child exits 0 (traps the signal) instead of dying by signal", async () => {
    const child = fakeChild(7105);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    // A well-behaved CLI can trap SIGTERM and shut down cleanly (exit 0, no
    // signal) instead of dying by the signal itself. That must not read as
    // "done" and bury the failureReason behind a healthy-looking status.
    child.emit("exit", 0, null);
    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "rate_limited");
  });

  test("ordinary crash text is not misclassified as a provider failure", () => {
    const child = fakeChild(7102);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "TypeError: cannot read property 'x' of undefined\n");
    child.emit("exit", 1, null);
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, null);
    assert.equal(s.failureDetail, null);
  });

  test("a type:\"text\" narration event that legitimately mentions rate limits, quotas, or 429 is not misclassified as a provider failure (GLM-5.2 review finding)", async () => {
    const child = fakeChild(7103);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "I hit a 429 while testing the client, so I added quota and rate-limit backoff handling per the usage-limit spec." } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
      ].join("\n") + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(killed.length, 0);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });

  test("insufficient_quota lands on payment_required, not rate_limited", async () => {
    const child = fakeChild(7106);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "insufficient_quota: your account has run out of credits" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "payment_required");
    assert.equal(s.failureDetail, "insufficient_quota: your account has run out of credits");
  });

  test("a line combining insufficient_quota and rate-limit language resolves to payment_required (checked first)", async () => {
    const child = fakeChild(7107);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate limit exceeded: insufficient_quota on this key" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "payment_required");
  });

  test("a line mentioning quota alongside rate-limit language, without insufficient_quota, resolves to rate_limited (bare quota's fallback bucket)", async () => {
    const child = fakeChild(7108);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Rate limit exceeded, check your quota" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "rate_limited");
  });

  test("unauthorized/invalid api key diagnostics land on authentication_failed", async () => {
    const child = fakeChild(7109);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Unauthorized: invalid API key provided" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "authentication_failed");
    assert.equal(s.failureDetail, "Unauthorized: invalid API key provided");
  });

  test("a raw non-JSON line with an unrelated 3-digit number is not misclassified as authentication_failed", () => {
    const child = fakeChild(7110);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "401 tests passed, 0 failed\n");
    child.emit("exit", 1, null);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });

  test("a structured status_code: 401 diagnostic without the word 'unauthorized' still lands on authentication_failed", async () => {
    const child = fakeChild(7111);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "request failed with status_code: 401" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "authentication_failed");
  });

  test("no_output_timeout captures which timeout fired and the pre/post-output latch state in failureDetail", async () => {
    const child = fakeChild(7112);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "no_output_timeout");
    assert.equal(s.failureDetail, "no output for 20ms (pre-output timeout)");
  });

  test("failureReason and failureDetail are set once; a second watchdog tick does not overwrite either", async () => {
    const child = fakeChild(7113);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 20));

    // Append a second, different diagnostic after the first tick has almost
    // certainly already classified and started killing the task.
    fs.appendFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Unauthorized: invalid API key provided" }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 20));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited", "the first classification wins");
    assert.equal(s.failureDetail, "rate_limit_exceeded: please retry after 60s");
  });
});
```

- [ ] **Step 2: Run the suite to confirm the new tests fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL. `failureReason` is still `"provider_usage_exhausted"` for every bucket, `failureDetail` doesn't exist yet, and the collision/401-anchor tests fail because the old single pattern list doesn't distinguish buckets.

- [ ] **Step 3: Add `failureDetail` to the `Task`, `TaskSummary`, and `ResultDetail` typedefs**

In `src/tasks.js`, in each of the three typedef blocks (around lines 22-43, 46-64, 100-119), add a line directly after the existing `@property {string|null} [failureReason]` line:

```javascript
 * @property {string|null} [failureDetail]
```

- [ ] **Step 4: Initialize `failureDetail: null` at both task-creation sites**

In `src/tasks.js`, in the `dispatch()` function's task object literal (around line 700), change:

```javascript
      failureReason: null,
      keySlot: resolvedKeySlot.keySlot,
```

to:

```javascript
      failureReason: null,
      failureDetail: null,
      keySlot: resolvedKeySlot.keySlot,
```

In the summary-task object literal (around line 918), change:

```javascript
      failureReason: null,
      summaryOf,
```

to:

```javascript
      failureReason: null,
      failureDetail: null,
      summaryOf,
```

- [ ] **Step 5: Replace `PROVIDER_EXHAUSTION_PATTERNS`/`detectProviderExhaustion` with the three-bucket classifier**

In `src/tasks.js`, replace lines 138-170 (the `PROVIDER_EXHAUSTION_PATTERNS` constant, its leading comment, and `detectProviderExhaustion`) with:

```javascript
// Ordered most-specific-first: real provider error text often combines
// more than one signal (e.g. "Rate limit exceeded, check your quota"), so
// the first bucket in this order that matches wins, rather than whichever
// pattern happens to be listed first in a flat scan.
//
// payment_required: `insufficient_quota` and `payment required`/`billing`
// are unambiguous billing signals that never mean "retry later works" the
// way a rate-limit message does.
const PAYMENT_REQUIRED_PATTERNS = [
  /insufficient_quota/i,
  /payment.?required/i,
  /\bbilling\b/i,
  /status(_code)?[:\s=]+402\b/i,
];
// authentication_failed: `unauthorized` / `invalid api key` are unambiguous
// auth signals. The bare 401 variant requires a `status`/`status_code`
// prefix rather than matching `\b401\b` on its own: a raw non-JSON log line
// (the noisiest scanning surface this classifier covers) can contain an
// unrelated 3-digit number (a byte count, a line number, a test count)
// that would otherwise false-positive.
const AUTHENTICATION_FAILED_PATTERNS = [
  /unauthorized/i,
  /invalid.api.?key/i,
  /authentication.?failed/i,
  /status(_code)?[:\s=]+401\b/i,
];
// rate_limited: the broadest, most generic bucket, checked last. Bare
// `quota` (without `insufficient_quota` or another payment_required
// signal) lands here deliberately: providers use "quota" for rate/usage
// budgets far more often than for billing failures, so an ambiguous bare
// mention defaults to the safer "transient, retry later" interpretation.
const RATE_LIMITED_PATTERNS = [
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /\b429\b/i,
  /\bquota\b/i,
];

const PROVIDER_FAILURE_BUCKETS = [
  /** @type {[string, RegExp[]]} */ (["payment_required", PAYMENT_REQUIRED_PATTERNS]),
  /** @type {[string, RegExp[]]} */ (["authentication_failed", AUTHENTICATION_FAILED_PATTERNS]),
  /** @type {[string, RegExp[]]} */ (["rate_limited", RATE_LIMITED_PATTERNS]),
];

const FAILURE_DETAIL_MAX_CHARS = 500;

/** @param {string} text */
function capDetail(text) {
  return text.length > FAILURE_DETAIL_MAX_CHARS ? text.slice(0, FAILURE_DETAIL_MAX_CHARS) + "…" : text;
}

// Scoped to opencode's own structured `type:"error"` events and raw
// non-JSON lines (stderr, crash text), never a `type:"text"` event's
// content. Those events are the model's own narration and routinely
// contain these same words in unrelated, healthy output (writing
// rate-limit-handling code, narrating "the server returned 429, retry
// with backoff"); scanning the whole raw log killed tasks mid-run on that
// false-positive surface (GLM-5.2 review of 0d944df..4e75129, finding 1).
/**
 * @param {string[]} lines
 * @returns {{bucket: string, detail: string} | null}
 */
function classifyProviderFailure(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      for (const [bucket, patterns] of PROVIDER_FAILURE_BUCKETS) {
        if (patterns.some((pattern) => pattern.test(line))) return { bucket, detail: capDetail(line) };
      }
      continue;
    }
    if (evt.type !== "error") continue;
    const text = typeof evt.message === "string" ? evt.message : JSON.stringify(evt);
    for (const [bucket, patterns] of PROVIDER_FAILURE_BUCKETS) {
      if (patterns.some((pattern) => pattern.test(text))) return { bucket, detail: capDetail(text) };
    }
  }
  return null;
}
```

- [ ] **Step 6: Update `failRunningTask` to accept and store `failureDetail`**

In `src/tasks.js`, change the `failRunningTask` function (lines 1154-1173):

```javascript
  /**
   * @param {Task} task
   * @param {string} failureReason
   * @param {string} [failureDetail]
   */
  function failRunningTask(task, failureReason, failureDetail) {
    if (task.failureReason) return; // already stopping this task
    task.failureReason = failureReason;
    task.failureDetail = failureDetail ?? null;
    stopRunningWatcher(task.id);
```

(the rest of the function body is unchanged).

- [ ] **Step 7: Update both watchdog call sites to use the new classifier and pass `failureDetail`**

In `src/tasks.js`'s `startRunningWatcher`, replace the provider-exhaustion check (around line 1224-1227):

```javascript
          if (detectProviderExhaustion(lines) || (carry && !carry.trimStart().startsWith("{") && detectProviderExhaustion([carry]))) {
            failRunningTask(current, "provider_usage_exhausted");
            return;
          }
```

with:

```javascript
          const providerFailure = classifyProviderFailure(lines)
            ?? (carry && !carry.trimStart().startsWith("{") ? classifyProviderFailure([carry]) : null);
          if (providerFailure) {
            failRunningTask(current, providerFailure.bucket, providerFailure.detail);
            return;
          }
```

Then update the `no_output_timeout` call site (around line 1252-1254):

```javascript
      if (Date.now() - lastActivityMs >= currentNoOutputTimeout) {
        failRunningTask(current, "no_output_timeout");
      }
```

to:

```javascript
      if (Date.now() - lastActivityMs >= currentNoOutputTimeout) {
        failRunningTask(current, "no_output_timeout", `no output for ${currentNoOutputTimeout}ms (${outputSeen ? "post-output" : "pre-output"} timeout)`);
      }
```

- [ ] **Step 8: Run the full suite, lint, typecheck**

Run: `node --test src/tasks.test.js && npm test && npm run lint && npm run typecheck`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): split provider_usage_exhausted into rate_limited/payment_required/authentication_failed, add failureDetail"
```

---

### Task 2: Remove `failureReason`/`failureDetail` duplication between `summarize()` and `result()`

**Files:**
- Modify: `src/tasks.js` (`summarize()` at lines ~572-587, `result()` at lines ~1599-1706, `RESULT_FIELDS` at line 135)
- Modify: `src/tasks.test.js` (add tests near the existing `result()`/`--fields` tests)

**Interfaces:**
- Consumes: `Task.failureReason`/`Task.failureDetail` from Task 1.
- Produces: `failureFields(task: Task) -> {failureReason: string|null, failureDetail: string|null}`, spread into both `summarize()`'s and `result()`'s return objects.
- Produces: `RESULT_FIELDS` gains `"failureDetail"`; the `--fields` validation error message is generated from `RESULT_FIELDS` instead of a separately hand-maintained string.

- [ ] **Step 1: Write failing tests for `--fields failureDetail` and the generated error message**

Find the existing tests exercising `RESULT_FIELDS`/`--fields` validation in `src/tasks.test.js` (search for `RESULT_FIELDS` or `fields must contain`) and add nearby:

```javascript
test("result --fields failureDetail returns the field", () => {
  const child = fakeChild(7201);
  const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
  const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
  fs.writeFileSync(mgr.status(dispatched.id).logPath, JSON.stringify({ type: "error", message: "insufficient_quota: out of credits" }) + "\n");
  child.emit("exit", 1, null);
  const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
  assert.equal(r.failureReason, "payment_required");
  assert.equal(r.failureDetail, "insufficient_quota: out of credits");
});

test("the --fields validation error message includes failureDetail", () => {
  const child = fakeChild(7202);
  const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
  const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
  child.emit("exit", 0, null);
  assert.throws(
    () => mgr.result(dispatched.id, { fields: ["not_a_real_field"] }),
    /failureDetail/
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/tasks.test.js`
Expected: FAIL. `failureDetail` is not in `RESULT_FIELDS` yet, and the error message doesn't mention it.

- [ ] **Step 3: Add the `failureFields` helper**

In `src/tasks.js`, directly above the `summarize()` function (around line 572), add:

```javascript
  /** @param {Task} task */
  function failureFields(task) {
    return { failureReason: task.failureReason ?? null, failureDetail: task.failureDetail ?? null };
  }
```

- [ ] **Step 4: Use the helper in `summarize()`**

Change `summarize()` (lines ~576-587) from:

```javascript
  function summarize(task) {
    const { promptPreview, promptTotalChars, id, status, directory, model, sessionId, pid, startedAt, endedAt, exitCode, signal, logPath, cancelRequested, failureReason, keySlot } = task;
    return {
      id, status, directory, model, sessionId, pid, startedAt, endedAt, exitCode, signal, logPath,
      failureReason: failureReason ?? null,
      keySlot: keySlot ?? null,
      promptPreview,
      ...(promptTotalChars != null ? { promptTotalChars } : {}),
      ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
      cancelRequested: !!cancelRequested,
    };
  }
```

to:

```javascript
  function summarize(task) {
    const { promptPreview, promptTotalChars, id, status, directory, model, sessionId, pid, startedAt, endedAt, exitCode, signal, logPath, cancelRequested, keySlot } = task;
    return {
      id, status, directory, model, sessionId, pid, startedAt, endedAt, exitCode, signal, logPath,
      ...failureFields(task),
      keySlot: keySlot ?? null,
      promptPreview,
      ...(promptTotalChars != null ? { promptTotalChars } : {}),
      ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
      cancelRequested: !!cancelRequested,
    };
  }
```

(note `failureReason` is dropped from the destructured field list since `failureFields` reads `task.failureReason` directly).

- [ ] **Step 5: Add `failureDetail` to `RESULT_FIELDS` and derive the error message from it**

Change line 135:

```javascript
const RESULT_FIELDS = new Set(["message", "narration", "tokens", "cost", "sessionId", "exitCode", "signal", "spawnError", "failureReason", "keySlot", "logPath"]);
```

to:

```javascript
const RESULT_FIELDS = new Set(["message", "narration", "tokens", "cost", "sessionId", "exitCode", "signal", "spawnError", "failureReason", "failureDetail", "keySlot", "logPath"]);
```

In `result()` (around line 1608-1611), change:

```javascript
      if (!Array.isArray(fields) || !fields.length || fields.some((field) => !RESULT_FIELDS.has(field))) {
        throw new Error("error: fields must contain one or more supported result fields\nhelp: use message, narration, tokens, cost, sessionId, exitCode, signal, spawnError, failureReason, keySlot, or logPath");
      }
```

to:

```javascript
      if (!Array.isArray(fields) || !fields.length || fields.some((field) => !RESULT_FIELDS.has(field))) {
        throw new Error(`error: fields must contain one or more supported result fields\nhelp: use one of: ${[...RESULT_FIELDS].join(", ")}`);
      }
```

- [ ] **Step 6: Use the helper in `result()`**

In `result()`'s return statement (around lines 1687-1705), change:

```javascript
    return projectResult({
      taskId,
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      spawnError: task.spawnError,
      failureReason: task.failureReason ?? null,
      keySlot: task.keySlot ?? null,
```

to:

```javascript
    return projectResult({
      taskId,
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      spawnError: task.spawnError,
      ...failureFields(task),
      keySlot: task.keySlot ?? null,
```

- [ ] **Step 7: Run the new tests and the full suite**

Run: `node --test src/tasks.test.js && npm test`
Expected: All PASS

- [ ] **Step 8: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: Both exit 0

- [ ] **Step 9: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "refactor(tasks): dedupe failureReason/failureDetail via failureFields(), derive --fields help text from RESULT_FIELDS"
```

---

### Task 3: Resume command hint on `leanStatus`'s `next` for crashed tasks with a salvageable session

**Files:**
- Modify: `src/output.js` (`leanStatus` at lines 57-91)
- Modify: `src/commands.test.js` (add tests near the existing `status`/`wait` command tests)

**Interfaces:**
- Consumes: `detail.sessionId`, `detail.directory`, both already present on every object `leanStatus` receives (`summarize()` from Task 1/2 includes `directory` unconditionally and `sessionId` always).
- Produces: `leanStatus(detail, { full })`'s `next` field, for `status === "crashed"` with a truthy `detail.sessionId`, becomes a resume-command string instead of the generic "run `taskferry result`" text. No other status path changes.

- [ ] **Step 1: Write failing tests**

Add to `src/commands.test.js` (anywhere near the other `status`/`wait` tests):

```javascript
test("status surfaces a resume hint when a crashed task has a salvageable sessionId", async () => {
  const client = {
    request: async (method, params) => {
      assert.equal(method, "task.status");
      assert.equal(params.taskId, "oc_7");
      return {
        id: "oc_7",
        status: "crashed",
        directory: "/workspace/project",
        sessionId: "ses_abc123",
        startedAt: "2026-07-17T00:00:00.000Z",
        exitCode: 1,
        signal: null,
        failureReason: "rate_limited",
      };
    },
  };
  const result = await runCommand("status", { taskId: "oc_7", full: false }, { client });
  assert.equal(
    result.next,
    'Session "ses_abc123" may be salvageable; resume with taskferry dispatch --session-id "ses_abc123" --directory "/workspace/project" --prompt "<continuation prompt>"'
  );
});

test("status keeps the generic hint for a crashed task with no sessionId", async () => {
  const client = {
    request: async () => ({
      id: "oc_8",
      status: "crashed",
      directory: "/workspace/project",
      sessionId: null,
      startedAt: "2026-07-17T00:00:00.000Z",
      exitCode: 1,
      signal: null,
      failureReason: "authentication_failed",
    }),
  };
  const result = await runCommand("status", { taskId: "oc_8", full: false }, { client });
  assert.equal(
    result.next,
    'Run taskferry result with task id "oc_8" to see the final message; pass --full here for directory/model/log path details'
  );
});

test("status keeps the running-task hint unaffected by the crashed-path change", async () => {
  const client = {
    request: async () => ({
      id: "oc_9",
      status: "running",
      directory: "/workspace/project",
      sessionId: "ses_should_be_ignored",
      startedAt: "2026-07-17T00:00:00.000Z",
      exitCode: null,
      signal: null,
    }),
  };
  const result = await runCommand("status", { taskId: "oc_9", full: false }, { client });
  assert.equal(
    result.next,
    'Run taskferry wait or taskferry status with task id "oc_9" to check progress; pass --full for directory/model/log path details'
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/commands.test.js`
Expected: FAIL. The first test's `next` is the old generic text, not the resume command.

- [ ] **Step 3: Update `leanStatus`'s `next` computation**

In `src/output.js`, change the `next` assignment inside `leanStatus` (lines 87-89):

```javascript
  lean.next = status === "running" || status === "queued"
    ? `Run taskferry wait or taskferry status with task id "${id}" to check progress; pass --full for directory/model/log path details`
    : `Run taskferry result with task id "${id}" to see the final message; pass --full here for directory/model/log path details`;
```

to:

```javascript
  lean.next = status === "running" || status === "queued"
    ? `Run taskferry wait or taskferry status with task id "${id}" to check progress; pass --full for directory/model/log path details`
    : status === "crashed" && detail.sessionId
      ? `Session "${detail.sessionId}" may be salvageable; resume with taskferry dispatch --session-id "${detail.sessionId}" --directory "${detail.directory}" --prompt "<continuation prompt>"`
      : `Run taskferry result with task id "${id}" to see the final message; pass --full here for directory/model/log path details`;
```

- [ ] **Step 4: Run the new tests and the full suite**

Run: `node --test src/commands.test.js && npm test`
Expected: All PASS

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: Both exit 0

- [ ] **Step 6: Commit**

```bash
git add src/output.js src/commands.test.js
git commit -m "feat(output): add resume-command hint to leanStatus for crashed tasks with a salvageable session"
```

---

### Task 4: Docs and final verification

**Files:**
- Modify: `docs/daemon.md` ("Watchdogs" section)
- Modify: `docs/troubleshooting.md` (consolidate the `provider_usage_exhausted` entry into one three-bucket entry)
- Modify: `docs/cli-reference.md` (`status` section)
- Modify: `todo.txt` (mark the two shipped VR items done, note the two dropped ones)

**Interfaces:** none. Documentation and verification only.

- [ ] **Step 1: Update `docs/daemon.md`'s "Watchdogs" section**

Replace the current provider-usage-exhaustion bullet:

```markdown
- A task stopped because its log matched a known provider-usage-exhaustion
  diagnostic (rate limit, quota, `429`, ...) instead gets `failureReason:
  "provider_usage_exhausted"`, distinct from a bare timeout so a caller
  knows to pick another key slot or model rather than just retrying.
```

with:

```markdown
- A task stopped because its log matched a known provider-failure
  diagnostic gets one of three `failureReason` values instead of a bare
  timeout, so a caller knows which corrective action fits:
  - `"rate_limited"`: rate limit, usage limit, `429`, too many requests, or
    a bare mention of `quota` with no billing-specific phrase nearby.
    Transient: retry later, or switch key slot in the meantime.
  - `"payment_required"`: `insufficient_quota`, `payment required`,
    `billing`, or a `402` status. The account behind that key slot needs a
    billing fix, not a retry.
  - `"authentication_failed"`: `unauthorized`, an invalid API key, or a
    `401` status. The credential in that key slot is broken and needs
    rotating.
  Each crash also carries `failureDetail`: the matched log line or
  provider error text (capped at 500 characters), or for
  `no_output_timeout`, which timeout value fired and whether it was before
  or after the task's first output.
```

- [ ] **Step 2: Consolidate `docs/troubleshooting.md`'s `provider_usage_exhausted` entry into one three-bucket entry**

Replace:

```markdown
## A task is stuck `crashed` with `failureReason: "provider_usage_exhausted"`

The watchdog matched a known rate-limit/quota/`429` diagnostic in the
task's log and stopped it early rather than let it burn the remaining grace
period against an exhausted key. Retry with a different `--model` or
`--key-slot` (see [security.md](security.md#provider-key-slots)) rather
than immediately retrying the same one.
```

with:

```markdown
## A task is stuck `crashed` with a provider-failure `failureReason`

The watchdog matched a known provider-failure diagnostic in the task's log
and stopped it early rather than let it burn the remaining grace period
against a key that was never going to succeed. Which of the three values
you see picks the fix; see [daemon.md](daemon.md#watchdogs) for exactly
what triggers each one:

- `"rate_limited"`: transient. Retry later, or switch `--key-slot`/`--model`
  in the meantime (see [security.md](security.md#provider-key-slots)).
- `"payment_required"`: the account behind that key slot needs a billing
  fix. Switching `--key-slot` to a different account works around it; the
  original slot needs attention regardless.
- `"authentication_failed"`: the credential in that key slot is broken.
  Rotate it, or switch `--key-slot` to a working one.

`taskferry status <id> --full` (or `result --fields failureDetail`) shows
the specific log line or error text that triggered the classification.
```

- [ ] **Step 3: Update `docs/cli-reference.md`'s `status` section**

Replace:

```markdown
Lean fields by default; pass `--full` for directory, model, session id, log
path, and prompt preview. `failureReason` is `null` unless the task was
stopped by the no-output watchdog (`"no_output_timeout"`) or
provider-usage-exhaustion detection (`"provider_usage_exhausted"`).
`keySlot` echoes the `--key-slot` name the task was dispatched with, or
`null`.
```

with:

```markdown
Lean fields by default; pass `--full` for directory, model, session id, log
path, and prompt preview. `failureReason` is `null` unless the task was
stopped by the no-output watchdog (`"no_output_timeout"`) or a
provider-failure diagnostic (`"rate_limited"`, `"payment_required"`, or
`"authentication_failed"`; see [daemon.md](daemon.md#watchdogs)).
`failureDetail` (also `--full`-only, or via `result --fields
failureDetail`) carries the matched log line or timeout detail behind
whichever `failureReason` fired. `keySlot` echoes the `--key-slot` name the
task was dispatched with, or `null`.
```

- [ ] **Step 4: Update `todo.txt`**

Under `TIER VR`, remove the "Failure detail field" and "Error classification (4-bucket system)" entries and the "Resume command hints on no_output_timeout crash" entry, replacing them with one `[X]` entry matching the style of other shipped entries (see the "LLM progress summaries" entry under `TIER IMPORTANT` for the exact format):

```
[X] Error classification, failure detail, and resume hints
    Status: shipped, on fix/summarize-followups
    Details: provider_usage_exhausted split into rate_limited/
             payment_required/authentication_failed, ordered
             most-specific-first to resolve real-world pattern overlap.
             New failureDetail field (matched log line, capped 500 chars,
             or the fired timeout for no_output_timeout) surfaced via
             --full and result --fields, deduped through a shared
             failureFields() helper. leanStatus's next hint on a crashed
             task with a salvageable sessionId now includes the resume
             command, for any failureReason bucket. Docs updated in
             daemon.md, troubleshooting.md, cli-reference.md.
```

Also remove the "Final marker validation" and "Empty message handling" entries from `TIER VR` entirely (dropped during spec review, no driving incident for either; see
`docs/superpowers/specs/2026-07-17-taskferry-error-classification-design.md`).

- [ ] **Step 5: Run the full verification suite**

Run: `npm test && npm run lint && npm run typecheck && npm run skill:check`
Expected: All exit 0. `skill:check` is unaffected by this change (`scripts/generate-skill.js` doesn't reference `failureReason`/`provider_usage_exhausted`); a failure here would indicate unrelated pre-existing drift, not something this plan introduces.

- [ ] **Step 6: Commit**

```bash
git add docs/daemon.md docs/troubleshooting.md docs/cli-reference.md todo.txt
git commit -m "docs: document rate_limited/payment_required/authentication_failed, failureDetail, and resume hints"
```
