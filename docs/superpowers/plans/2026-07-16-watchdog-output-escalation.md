# No-Output Watchdog Output Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-task no-output watchdog two-phase: keep the existing short `noOutputTimeoutMs` budget while the task has produced zero parseable log events, and once any parseable log event has been seen, escalate (latch) to a longer `postOutputNoOutputTimeoutMs` budget for the remainder of that task's life — so a long generation that goes silent mid-write is no longer SIGTERM'd by the watchdog.

**Architecture:** All changes live inside `createTaskManager()` in `src/tasks.js`. The watchdog closure in `startRunningWatcher()` already reads each new log chunk, parses lines as JSON, and resets `lastActivityMs` on the first parseable line; we extend that one closure with a latch flag and a "current deadline" variable, and plumb a second timeout through the factory options and a second module-level env var alongside the existing `TASKFERRY_NO_OUTPUT_TIMEOUT_MS`. No new modules, no new dependencies, no external interface changes.

**Tech Stack:** Node.js (`node:test` for unit tests via `npm test`), `node:fs` synchronous APIs, the existing `positiveInteger(value, fallback)` helper at `src/tasks.js:189-191`.

## Global Constraints

- `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` keeps its current meaning: the budget that applies while the task has produced zero parseable log events (default 120000 ms, behavior unchanged for callers that only set this).
- The new env var `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` (default 300000 ms) is the budget after the watcher has seen at least one parseable JSON line in the log; it latches for the rest of the task.
- Both budgets are independently injectable on `createTaskManager({...})` as `noOutputTimeoutMs` and `postOutputNoOutputTimeoutMs`, mirroring the existing `noOutputTimeoutMs` / `watchdogPollMs` pair, so unit tests can run with millisecond-scale deadlines.
- The "first parseable log line" signal is exactly what `startRunningWatcher` already uses today: a complete line in the ndjson log that `JSON.parse` accepts. No new activity signal is invented and no token-streaming detection is attempted (the log does not carry it).
- The existing `setInterval(..., watchdogPoll)` in `startRunningWatcher` stays `timer.unref()`'d and the explanatory comment above it stays verbatim.
- `tasks.json` is not modified by this change: escalation state lives in the watcher closure only, per task, and is reset whenever `startRunningWatcher` is called fresh for a task.
- No `/home/...`, `/workspace/...`, `/Users/...`, or `/root/...` path literals appear anywhere in tests, code, or this plan.
- OUT OF SCOPE: a per-dispatch `--no-output-timeout-ms` CLI flag, changes to `MAX_WAIT_MS` / the `wait` timeout clamp, the `done`-with-empty-message issue, README/daemon.md/troubleshooting.md docs updates, `server.js` tool-schema changes. This plan covers the watchdog escalation only.

---

## File Structure

- **Modify** `src/tasks.js` — add `DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` constant (next to `DEFAULT_NO_OUTPUT_TIMEOUT_MS` at `src/tasks.js:251-254`); add the `postOutputNoOutputTimeoutMs` JSDoc line on the factory options block (near `src/tasks.js:272`); add the matching destructure default in the factory signature (near `src/tasks.js:308`); add the `positiveInteger(...)` normalization (near `src/tasks.js:328`); and modify `startRunningWatcher()` (currently `src/tasks.js:1160-1226`) to track a per-task latch and use the escalated deadline.
- **Modify** `src/tasks.test.js` — add the `postOutputNoOutputTimeoutMs` pass-through to the `makeManager` fixture's existing option-spread block (near `src/tasks.test.js:38`); update the existing "goes silent again after early output" test (currently `src/tasks.test.js:500-517`) to inject `postOutputNoOutputTimeoutMs` so it still exercises the post-output watchdog after the change; add three new tests under the existing `describe("no-output watchdog", ...)` block at `src/tasks.test.js:428` covering: (a) a task that produces one log event then goes silent survives past the pre-output budget, (b) the escalated budget is still enforced and fires no earlier than `postOutputNoOutputTimeoutMs`, and (c) the daemon-restart re-adoption edge case where the log already has parseable JSON when the watcher starts.

No other files are created or modified.

---

### Task 1: Plumb the post-output budget through `createTaskManager` (no behavior change yet)

**Files:**
- Modify: `src/tasks.js:251-254` (add the new module-level default alongside `DEFAULT_NO_OUTPUT_TIMEOUT_MS`).
- Modify: `src/tasks.js:272` (add a JSDoc `@param` line for the new factory option).
- Modify: `src/tasks.js:308` (add the matching destructure default in the factory signature).
- Modify: `src/tasks.js:328` (add the matching `positiveInteger(...)` normalization).
- Modify: `src/tasks.test.js:38` (forward the new option through `makeManager`'s existing option-spread block).

**Interfaces:**
- Consumes: nothing new beyond the existing `positiveInteger(value, fallback)` helper at `src/tasks.js:189-191`.
- Produces: `createTaskManager({ ..., noOutputTimeoutMs, postOutputNoOutputTimeoutMs, ... })` accepts the new option; `postOutputNoOutputTimeout` becomes a closure-local number alongside `noOutputTimeout` at `src/tasks.js:328`. The default is read from `process.env.TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS`, falling back to `300000`. No call site uses `postOutputNoOutputTimeout` yet, so this is purely additive.

- [ ] **Step 1: Add `DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` next to `DEFAULT_NO_OUTPUT_TIMEOUT_MS`**

Edit `src/tasks.js` immediately after the existing `DEFAULT_NO_OUTPUT_TIMEOUT_MS` block at `src/tasks.js:251-254`. Insert the new constant on the same pattern (same `positiveInteger(Number(process.env.X), fallback)` shape used by every other `DEFAULT_*` in this file):

```javascript
const DEFAULT_NO_OUTPUT_TIMEOUT_MS = positiveInteger(
  Number(process.env.TASKFERRY_NO_OUTPUT_TIMEOUT_MS),
  120000
);
const DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS = positiveInteger(
  Number(process.env.TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS),
  300000
);
```

- [ ] **Step 2: Add the `postOutputNoOutputTimeoutMs` `@param` to the factory JSDoc**

Edit the factory options JSDoc block in `src/tasks.js` (currently lines `262-282`). Add a new `@param` immediately after the existing `@param {number} [options.noOutputTimeoutMs]` line, on the same indentation and JSDoc shape as the surrounding entries:

```javascript
  /**
   * @param {object} [options]
   * @param {typeof spawn} [options.spawnFn]
   * @param {(pid: number, signal: NodeJS.Signals) => void} [options.killFn]
   * @param {(env?: NodeJS.ProcessEnv) => Promise<string>} [options.listModelsFn]
   * @param {(env: NodeJS.ProcessEnv) => Promise<void>} [options.verifySummaryAgentFn]
   * @param {string} [options.stateDir]
   * @param {number} [options.maxDispatchesPerWindow]
   * @param {number} [options.dispatchWindowMs]
   * @param {number} [options.maxConcurrentTasks]
   * @param {number} [options.advisorSessionTtlMs]
   * @param {number} [options.noOutputTimeoutMs]
   * @param {number} [options.postOutputNoOutputTimeoutMs]
   * @param {number} [options.watchdogPollMs]
   * @param {string} [options.keySlotsSpec]
   * @param {string|null} [options.providerKeyEnvName]
   * @param {string|null} [options.summaryKeySlot]
   * @param {string|null} [options.summaryProviderKeyEnvName]
   * @param {boolean} [options.activitySummariesEnabled]
   * @param {number} [options.activityMinIntervalMs]
   * @param {string} [options.activitySummaryModel]
   * @param {number} [options.activityMaxWords]
   * @param {(event: object) => void} [options.onEvent]
   */
```

- [ ] **Step 3: Add the destructure default to the factory signature**

Edit the `createTaskManager({ ... } = {})` signature in `src/tasks.js` (currently lines `289-319`). Add the new destructure entry immediately after `noOutputTimeoutMs`:

```javascript
export function createTaskManager({
  spawnFn = spawn,
  killFn = (pid, signal) => process.kill(pid, signal),
  listModelsFn = async (env) => (await execFileAsync("opencode", ["models"], { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env })).stdout,
  verifySummaryAgentFn = async (env) => {
    const { stdout, stderr } = await execFileAsync(
      "opencode",
      ["debug", "agent", SUMMARY_AGENT, "--pure", "--tool", "bash", "--params", JSON.stringify({ command: "true" })],
      { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env }
    );
    if (!/disabled|denied/i.test(`${stdout}\n${stderr}`)) {
      throw new Error("summary agent allowed bash");
    }
  },
  stateDir = DEFAULT_STATE_DIR,
  maxDispatchesPerWindow = DEFAULT_MAX_DISPATCHES_PER_WINDOW,
  dispatchWindowMs = DEFAULT_DISPATCH_WINDOW_MS,
  maxConcurrentTasks = DEFAULT_MAX_CONCURRENT_TASKS,
  advisorSessionTtlMs = DEFAULT_ADVISOR_SESSION_TTL_MS,
  noOutputTimeoutMs = DEFAULT_NO_OUTPUT_TIMEOUT_MS,
  postOutputNoOutputTimeoutMs = DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS,
  watchdogPollMs = DEFAULT_WATCHDOG_POLL_MS,
  keySlotsSpec = process.env.TASKFERRY_KEY_SLOTS,
  providerKeyEnvName = process.env.TASKFERRY_PROVIDER_KEY_ENV || null,
  summaryKeySlot = process.env.TASKFERRY_SUMMARY_KEY_SLOT || null,
  summaryProviderKeyEnvName = process.env.TASKFERRY_SUMMARY_PROVIDER_KEY_ENV || null,
  activitySummariesEnabled = process.env.TASKFERRY_ACTIVITY_SUMMARIES !== "0",
  activityMinIntervalMs = Number(process.env.TASKFERRY_ACTIVITY_MIN_INTERVAL_MS),
  activitySummaryModel = SUMMARY_MODEL,
  activityMaxWords = 200,
  onEvent,
} = {}) {
```

- [ ] **Step 4: Add the closure-local `positiveInteger(...)` normalization**

Edit the existing block of `positiveInteger(...)` normalizations in `src/tasks.js` (currently lines `324-329`). Add the new entry immediately after `noOutputTimeout`:

```javascript
  const dispatchLimit = positiveInteger(maxDispatchesPerWindow, DEFAULT_MAX_DISPATCHES_PER_WINDOW);
  const dispatchWindow = positiveInteger(dispatchWindowMs, DEFAULT_DISPATCH_WINDOW_MS);
  const concurrencyLimit = positiveInteger(maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS);
  const advisorTtl = positiveInteger(advisorSessionTtlMs, DEFAULT_ADVISOR_SESSION_TTL_MS);
  const noOutputTimeout = positiveInteger(noOutputTimeoutMs, DEFAULT_NO_OUTPUT_TIMEOUT_MS);
  const postOutputNoOutputTimeout = positiveInteger(postOutputNoOutputTimeoutMs, DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS);
  const watchdogPoll = positiveInteger(watchdogPollMs, DEFAULT_WATCHDOG_POLL_MS);
```

- [ ] **Step 5: Forward the new option through `makeManager` in the test file**

Edit `src/tasks.test.js` (currently lines `16-45`). Add the new field to both the `makeManager` parameter list and the option-spread block so existing tests can keep passing the `noOutputTimeoutMs` / `watchdogPollMs` pair unchanged, and new tests can pass `postOutputNoOutputTimeoutMs` the same way:

```javascript
function makeManager({ tasksFixture = [], logs = {}, spawnFn, killFn, listModelsFn, verifySummaryAgentFn, maxDispatchesPerWindow, dispatchWindowMs, advisorSessionTtlMs, maxConcurrentTasks, noOutputTimeoutMs, postOutputNoOutputTimeoutMs, watchdogPollMs, keySlotsSpec, providerKeyEnvName, summaryKeySlot, summaryProviderKeyEnvName, onEvent } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
  const logDir = path.join(stateDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const fixtureTasks = typeof tasksFixture === "function" ? tasksFixture(logDir) : tasksFixture;
  fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify(fixtureTasks, null, 2));
  for (const [name, content] of Object.entries(logs)) {
    fs.writeFileSync(path.join(logDir, name), content);
  }

  return createTaskManager({
    stateDir,
    spawnFn: spawnFn ?? (() => { throw new Error("spawnFn was not injected for this test"); }),
    killFn: killFn ?? (() => { throw new Error("killFn was not injected for this test"); }),
    listModelsFn: listModelsFn ?? (() => "opencode-go/deepseek-v4-flash\n"),
    verifySummaryAgentFn: verifySummaryAgentFn ?? (async () => {}),
    ...(onEvent != null ? { onEvent } : {}),
    ...(maxDispatchesPerWindow != null ? { maxDispatchesPerWindow } : {}),
    ...(dispatchWindowMs != null ? { dispatchWindowMs } : {}),
    ...(advisorSessionTtlMs != null ? { advisorSessionTtlMs } : {}),
    ...(maxConcurrentTasks != null ? { maxConcurrentTasks } : {}),
    ...(noOutputTimeoutMs != null ? { noOutputTimeoutMs } : {}),
    ...(postOutputNoOutputTimeoutMs != null ? { postOutputNoOutputTimeoutMs } : {}),
    ...(watchdogPollMs != null ? { watchdogPollMs } : {}),
    ...(keySlotsSpec != null ? { keySlotsSpec } : {}),
    ...(providerKeyEnvName != null ? { providerKeyEnvName } : {}),
    ...(summaryKeySlot != null ? { summaryKeySlot } : {}),
    ...(summaryProviderKeyEnvName != null ? { summaryProviderKeyEnvName } : {}),
  });
}
```

- [ ] **Step 6: Run the unit suite and confirm behavior is unchanged**

Run: `npm test`
Expected: every test passes, same as before this task. The new env var, factory option, and closure-local number exist but no code path reads them yet, so observable behavior is identical. Specifically the four tests under `describe("no-output watchdog", ...)` (`src/tasks.test.js:428-518`) all still pass with no modifications.

- [ ] **Step 7: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): plumb post-output no-output timeout option"
```

---

### Task 2: Make `startRunningWatcher` escalate the budget after first parseable JSON line

**Files:**
- Modify: `src/tasks.js:1160-1226` (`startRunningWatcher` body — add the latch flag and the per-tick "current deadline" variable; flip both when a JSON line is parsed; use the escalated deadline in the deadline comparison at `src/tasks.js:1214-1216`).
- Modify: `src/tasks.test.js:500-517` (the existing "goes silent again after early output is eventually stopped" test — inject `postOutputNoOutputTimeoutMs: 20` so it still exercises the post-output watchdog under the new option, since the default 300000 ms would otherwise dwarf the test's 70 ms wait).
- Modify: `src/tasks.test.js:428-518` (the `describe("no-output watchdog", ...)` block — add three new tests covering: budget escalation on the first JSON line; the escalated budget still being enforced and firing no earlier than `postOutputNoOutputTimeoutMs`; and the daemon-restart re-adoption edge case where the log already has parseable JSON when the watcher's first tick reads it).

**Interfaces:**
- Consumes: `noOutputTimeout` and `postOutputNoOutputTimeout` (the two closure-local numbers Task 1 added at `src/tasks.js:328-329`). The single new in-closure variable is the per-tick "current deadline" (typed as `number`), and the single new latch flag is `outputSeen` (typed as `boolean`).
- Produces: `startRunningWatcher(task)` behavior change. The deadline check at `src/tasks.js:1214` (`if (Date.now() - lastActivityMs >= noOutputTimeout)`) is replaced with one that compares against the current per-tick deadline, which starts as `noOutputTimeout` and latches to `postOutputNoOutputTimeout` the first time a JSON line is parsed. The interval still has `timer.unref()` called on it (line `1224`) and the explanatory comment above it (`src/tasks.js:1218-1223`) is preserved verbatim.

- [ ] **Step 1: Update the existing "goes silent again after early output" test so it keeps passing after the change**

Edit `src/tasks.test.js` (currently lines `500-517`). Add `postOutputNoOutputTimeoutMs: 20` alongside `noOutputTimeoutMs: 20` so the post-output watchdog (which now uses the new option) fires within the test's 70 ms wait. Without this update the test would hang for the default 300000 ms and the existing assertion would fail. The replacement block is:

```javascript
  test("a running child that goes silent again after early output is eventually stopped (GLM-5.2 review finding)", async () => {
    const child = fakeChild(7003);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "working..." } }) + "\n");

    await new Promise((r) => setTimeout(r, 70));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"), "watchdog must eventually fire after the last activity, not just the start");

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "no_output_timeout");
  });
```

- [ ] **Step 2: Run tests to confirm the updated test still passes (no behavior change yet)**

Run: `npm test`
Expected: every test passes, including the updated existing test. The Task 1 plumbing exists but `startRunningWatcher` still ignores `postOutputNoOutputTimeout`, so the escalation has not happened yet — this step's purpose is to confirm the test still works under today's behavior, isolating the TDD failure of the next two steps to the new tests only.

- [ ] **Step 3: Add three failing tests for the escalation behavior**

Edit `src/tasks.test.js` — the `describe("no-output watchdog", ...)` block (currently `src/tasks.test.js:428-518`). Add the three new tests immediately before the closing `});` of that describe block (currently `src/tasks.test.js:518`). The new tests use the existing `makeManager` / `fakeChild` fixtures and the existing `fs.appendFileSync` / `fs.writeFileSync` patterns already used by the surrounding watchdog tests.

The first two tests assert only *lower* bounds on when the watchdog fires. A loaded machine can only delay a timer, never fire it early, so a lower bound is robust under CI load while an upper bound would be flaky. The third test (re-adoption) uses an explicit `killFn` timestamp for the same reason.

```javascript
  test("one log event then silence: the task survives well past noOutputTimeoutMs because the budget escalated", async () => {
    // The regression this whole change exists for: a task does real work,
    // then goes quiet to compose one long final answer. opencode writes
    // step-level events, not token deltas, so the log goes silent for
    // minutes and the pre-output budget would SIGTERM the task mid-write.
    //
    // Pre-change this test FAILS: postOutputNoOutputTimeoutMs is ignored,
    // the budget stays at 20 ms, and the SIGTERM lands ~25 ms in.
    const child = fakeChild(7005);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 10000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;

    // One parseable line lands before the pre-output deadline, flipping the
    // latch. Everything from here to the assert is silence.
    fs.appendFileSync(logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "working..." } }) + "\n");

    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(killed, [], "after one parseable log event, the escalated budget must keep the task alive past noOutputTimeoutMs");
    assert.equal(mgr.status(dispatched.id).status, "running");

    child.emit("exit", 0, null);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });

  test("the escalated budget is still a deadline: silence past postOutputNoOutputTimeoutMs kills, and never before it", async () => {
    // Escalation must not mean "no watchdog at all" -- a genuinely hung task
    // that produced some output early still has to die, just on the longer
    // budget. The timing assertion is what makes this test discriminating:
    // pre-change the kill lands at the 20 ms pre-output budget, so asserting
    // the kill happened no earlier than 40 ms fails. Post-change it lands at
    // ~60 ms. Only a lower bound is asserted, since load can delay a timer
    // but never fire it early.
    const child = fakeChild(7006);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal, at: Date.now() }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 60,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;

    const seededAt = Date.now();
    fs.appendFileSync(logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "first event" } }) + "\n");

    await new Promise((r) => setTimeout(r, 200));
    const sigterm = killed.find((k) => k.signal === "SIGTERM");
    assert.ok(sigterm, "the post-output watchdog must still fire on continued silence past postOutputNoOutputTimeoutMs");
    assert.ok(
      sigterm.at - seededAt >= 40,
      `the kill must respect the escalated budget, not the 20 ms pre-output one (fired ${sigterm.at - seededAt} ms after the log event)`
    );

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "no_output_timeout");
  });

  test("a re-adopted task whose log already contains parseable JSON comes back already escalated (daemon-restart edge case)", async () => {
    // Models the case where a daemon restart picks up a still-running task:
    // startRunningWatcher() initializes bytesRead = 0, so its first tick
    // reads the ENTIRE existing log at once. If that log already has a
    // parseable JSON line, the task has produced output before and must
    // come back at the post-output budget, not at the short one.
    //
    // The test reproduces this without touching internal manager state by
    // pre-seeding the log file BEFORE the first watcher tick fires.
    // dispatch() opens the log file in append mode (fs.openSync(..., "a",
    // 0o600) at src/tasks.js:977), which preserves pre-existing content
    // instead of truncating it. The watcher's first tick then reads the
    // pre-seeded JSON from offset 0 -- exactly the path a re-adopted
    // watcher's first tick would take against an already-populated log.
    //
    // All code between dispatch() returning and fs.writeFileSync() returning
    // runs synchronously in the test thread, so the watcher's first interval
    // tick (scheduled via setInterval for `watchdogPollMs` ms later) cannot
    // fire before the seed is on disk.
    const child = fakeChild(7007);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 60,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;
    fs.writeFileSync(logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "from before" } }) + "\n");

    // Wait past noOutputTimeoutMs (20 ms) plus a comfortable buffer. With
    // the latch broken, the SIGTERM lands here because the budget stays at
    // 20 ms even though the log already contains parseable JSON. With the
    // latch working, the very first tick reads the pre-seeded JSON, the
    // outputSeen flag flips, and the deadline jumps to 60 ms.
    await new Promise((r) => setTimeout(r, 35));
    assert.deepEqual(killed, [], "watchdog must NOT fire at noOutputTimeoutMs when the log already contains parseable JSON");

    // Wait past postOutputNoOutputTimeoutMs (60 ms). The latch means the
    // deadline stays escalated at 60 ms, so continued silence must trigger
    // the SIGTERM at exactly the post-output budget, not at noOutputTimeoutMs
    // (broken latch) and not at the 300 s default (broken escalation).
    await new Promise((r) => setTimeout(r, 100));
    const sigterm = killed.find((k) => k.signal === "SIGTERM");
    assert.ok(sigterm, "after the latch from pre-existing JSON, the post-output watchdog must still fire on continued silence");

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "no_output_timeout");
  });
```

- [ ] **Step 4: Run tests to confirm all three new tests fail**

Run: `npm test`
Expected: all three new tests FAIL, because `startRunningWatcher` still ignores `postOutputNoOutputTimeoutMs` and every task is still held to the 20 ms pre-output budget.
- Test 1 fails on `after one parseable log event, the escalated budget must keep the task alive past noOutputTimeoutMs` — `killed` contains a SIGTERM that landed ~25 ms in.
- Test 2 fails on `the kill must respect the escalated budget, not the 20 ms pre-output one (fired ~25 ms after the log event)` — the kill happened, but far too early.
- Test 3 fails on `watchdog must NOT fire at noOutputTimeoutMs when the log already contains parseable JSON` — the SIGTERM landed at ~25 ms because the latch never flipped, even though the pre-seeded JSON was on disk before the first tick.

All other tests pass. This isolates the failure to the missing escalation logic, not to anything else in the change.

- [ ] **Step 5: Implement the escalation in `startRunningWatcher`**

Edit `src/tasks.js` (currently `src/tasks.js:1160-1226`). Replace the entire `startRunningWatcher` function body with the following. The only behavioral changes are:
1. Two new closure-local variables (`outputSeen` and `currentNoOutputTimeout`) alongside the existing `lastActivityMs`, `bytesRead`, `carry`.
2. The JSON-line detection at `src/tasks.js:1199-1208` flips `outputSeen = true` and `currentNoOutputTimeout = postOutputNoOutputTimeout` (in addition to its existing `lastActivityMs = Date.now()` reset).
3. The deadline comparison at `src/tasks.js:1214` reads `currentNoOutputTimeout` instead of `noOutputTimeout`.
4. The `timer.unref()` call at line 1224 and the explanatory comment immediately above it (`src/tasks.js:1218-1223`) are preserved verbatim.

```javascript
  /** @param {Task} task */
  function startRunningWatcher(task) {
    let lastActivityMs = Date.now();
    // Tracks how much of the log this watcher has already scanned, so each
    // tick reads and regexes only the bytes appended since the last one
    // instead of the whole file (O(1) amortized per tick, not O(n) per tick
    // / O(n²) over a long-running task). `carry` holds a trailing partial
    // line from the previous read until it's completed by the next chunk.
    let bytesRead = 0;
    let carry = "";
    // Two-phase no-output budget:
    //   - Before the task has produced any parseable log event, the watcher
    //     compares against `noOutputTimeout`. A task that is silent from the
    //     start is most likely genuinely wedged (bad spawn, auth failure,
    //     provider hang) and should die fast.
    //   - The moment the watcher sees its first parseable JSON line in the
    //     log, the latch flips and the deadline jumps to
    //     `postOutputNoOutputTimeout` for the rest of the task's life.
    //     Silence after real work is far more likely a long generation
    //     (opencode writes step-level events, not token deltas, so a long
    //     final answer can produce zero log lines for minutes) than a hang.
    let outputSeen = false;
    let currentNoOutputTimeout = noOutputTimeout;
    const timer = setInterval(() => {
      const current = tasks.get(task.id);
      if (!current || current.status !== "running") {
        stopRunningWatcher(task.id);
        return;
      }
      try {
        const size = fs.statSync(current.logPath).size;
        if (size < bytesRead) {
          // Log shrank or was replaced out from under us; rescan from scratch.
          bytesRead = 0;
          carry = "";
        }
        if (size > bytesRead) {
          const chunkSize = size - bytesRead;
          const buf = Buffer.alloc(chunkSize);
          const fd = fs.openSync(current.logPath, "r");
          try {
            fs.readSync(fd, buf, 0, chunkSize, bytesRead);
          } finally {
            fs.closeSync(fd);
          }
          bytesRead = size;
          const text = carry + buf.toString("utf8");
          const lines = text.split("\n");
          carry = lines.pop() ?? "";
          if (detectProviderExhaustion(lines) || (carry && !carry.trimStart().startsWith("{") && detectProviderExhaustion([carry]))) {
            failRunningTask(current, "provider_usage_exhausted");
            return;
          }
          if (lines.some((line) => {
            try {
              JSON.parse(line);
              return true;
            } catch {
              return false;
            }
          })) {
            lastActivityMs = Date.now();
            // Latch the budget escalation: once any parseable JSON line has
            // landed for this task, every subsequent tick compares against
            // `postOutputNoOutputTimeout` regardless of how much later silence
            // follows. This is the only assignment to either flag/variable
            // outside their initializers, so the latch is unconditional.
            if (!outputSeen) {
              outputSeen = true;
              currentNoOutputTimeout = postOutputNoOutputTimeout;
            }
          }
          void scheduleActivity(current);
        }
      } catch {
        // A rotated or removed log is retried on the next watcher tick.
      }
      if (Date.now() - lastActivityMs >= currentNoOutputTimeout) {
        failRunningTask(current, "no_output_timeout");
      }
    }, watchdogPoll);
    // Same as child.unref() in startTask: the watchdog is a background
    // observer, not something that should pin the server's event loop alive.
    // An unref'd interval still fires while the loop is otherwise busy, but
    // lets the process exit if nothing else (real work, child subprocesses,
    // waiters) is keeping it alive -- e.g. tests that cancel a task without
    // firing an 'exit' event.
    timer.unref();
    runningWatchers.set(task.id, timer);
  }
```

- [ ] **Step 6: Run the full unit suite and confirm every test passes**

Run: `npm test`
Expected: every test passes — the four pre-existing watchdog tests plus the three new ones from Step 3, seven in total under `describe("no-output watchdog", ...)`. The pre-existing four still hold: the test at `src/tasks.test.js:429` keeps killing at `noOutputTimeoutMs = 20` because no JSON ever lands (the pre-output budget is deliberately unchanged); `src/tasks.test.js:456` keeps surviving because JSON keeps landing before every deadline; `src/tasks.test.js:480` keeps killing because its output is non-JSON noise that never flips the latch; and `src/tasks.test.js:500` was updated in Step 1 to inject `postOutputNoOutputTimeoutMs: 20`.

- [ ] **Step 7: Run lint and typecheck**

Run: `npm run lint`
Expected: clean. The new code follows the same formatting as the surrounding file: two-space indent, double-quoted strings, semicolon-terminated statements. ESLint allows either single or double quotes here, and the surrounding file uses double quotes for string literals (see the existing `fs.openSync(task.logPath, "a", 0o600)` at `src/tasks.js:977`), so the new code matches.

Run: `npm run typecheck`
Expected: clean. The new JSDoc-typed local variables (`@type` is implicit through assignment shape; `outputSeen` is a `boolean` from its `false` literal, `currentNoOutputTimeout` is a `number` from its `noOutputTimeout` initializer). No new JSDoc annotations are required.

- [ ] **Step 8: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): escalate no-output watchdog after first log event"
```

---

### Task 3: Final verification

**Files:** none modified.

- [ ] **Step 1: Run the full unit suite end-to-end**

Run: `npm test`
Expected: every test passes. All seven `describe("no-output watchdog", ...)` tests (the four pre-existing tests, one of them updated in Task 2 Step 1, plus the three new tests from Task 2 Step 3) pass, alongside every other suite.

- [ ] **Step 2: Run lint and typecheck one more time on the final tree**

Run: `npm run lint && npm run typecheck`
Expected: both clean, no warnings.

- [ ] **Step 3: Confirm `git status` matches the two intended commits**

Run: `git status --short`
Expected: either empty (clean tree) or only unrelated working-tree changes that were already present before this plan started. The two new commits from Tasks 1 and 2 should be the only modifications introduced by this plan.

No commit is required for Task 3 — its purpose is to verify the work, not to introduce more changes.
