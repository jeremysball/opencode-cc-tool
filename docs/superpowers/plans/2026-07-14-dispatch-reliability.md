# Dispatch Reliability and Key Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delegated `opencode` tasks in taskferry (`src/tasks.js` / `src/server.js`) fail clearly on provider-usage exhaustion or a silent hung child, cap active child processes at a configurable limit (default 4) independent of the existing launch-rate window, let a caller pick a preconfigured provider key by name without ever exposing its value, and make `tasks.json` durable under concurrent MCP server processes.

**Architecture:** All changes live in the existing `createTaskManager()` factory in `src/tasks.js` (single Node process, in-memory `Map` of tasks, one `opencode` child per task) plus a new small synchronous file-lock helper (`src/state-lock.js`). No new runtime dependencies. `src/server.js` only grows a `key_slot` input and updated tool descriptions.

**Tech Stack:** Node.js (`node:test` for unit tests), `child_process.spawn`, `node:fs` synchronous APIs, `Atomics.wait` for a synchronous inter-process lock wait.

## Global Constraints

- Never put a secret key value into `tasks.json`, log files, prompt previews, tool responses, or command arguments — only a `keySlot` *name* may be persisted or returned (source: Design §Key Slots, Non-Goals).
- `TASKFERRY_MAX_CONCURRENT_TASKS` defaults to `4` and is a real cap on concurrently `running` children, independent of the existing launch-rate window (source: Design §Active-Task Concurrency).
- The existing `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` / `TASKFERRY_DISPATCH_WINDOW_MS` remain only as an optional burst-rate control and must not be documented as a concurrency limit (source: Design §Active-Task Concurrency item 4).
- A no-output watchdog timeout (`failureReason: "no_output_timeout"`) is distinct from a confirmed provider-usage failure (`failureReason: "provider_usage_exhausted"`) — never infer the latter from a bare timeout (source: Non-Goals).
- All new `stateDir` files keep the existing `0o600`/`0o700` permission discipline already used by `persist()`/`loadPersisted()`.
- Every new constructor option must be injectable on `createTaskManager({...})`, mirroring `maxDispatchesPerWindow`/`dispatchWindowMs`, so tests never touch real env vars or real timers longer than a few tens of milliseconds.

---

## File Structure

- **Create** `src/state-lock.js` — synchronous cross-process file lock (`withFileLock`) used to make `tasks.json` writes safe across concurrent taskferry server processes.
- **Create** `src/state-lock.test.js` — unit tests for the lock helper in isolation (no dependency on `tasks.js`).
- **Modify** `src/tasks.js` — replace whole-map `persist()` with a locked, merge-based `persistTask(taskId)`; add active-concurrency cap; add the no-output watchdog and provider-exhaustion detector (`failureReason` field); add key-slot resolution for dispatch/advisor and for summary tasks.
- **Modify** `src/tasks.test.js` — tests for every behavior above, using the existing `makeManager()`/`fakeChild()` fixtures.
- **Modify** `src/cancel-smoke-test.js` — fix the missing `decode` import (prerequisite defect noted in the design doc's Current Evidence).
- **Modify** `src/server.js` — add `key_slot` to `taskferry_dispatch`'s input schema and pass it through; update the `taskferry_dispatch` tool description so it no longer implies the launch window is a concurrency cap.
- **Modify** `README.md` — document `TASKFERRY_MAX_CONCURRENT_TASKS`, `TASKFERRY_NO_OUTPUT_TIMEOUT_MS`, `TASKFERRY_PROVIDER_CHECK_INTERVAL_MS`, `TASKFERRY_KEY_SLOTS`, `TASKFERRY_PROVIDER_KEY_ENV`, `TASKFERRY_SUMMARY_KEY_SLOT`, `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV`, `failureReason`, and `key_slot`.

---

### Task 1: Fix the missing `decode` import in `cancel-smoke-test.js`

**Files:**
- Modify: `src/cancel-smoke-test.js:1-9`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new; this only fixes a `ReferenceError` at runtime so the existing integration smoke test can run at all.

- [ ] **Step 1: Add the missing import**

`src/cancel-smoke-test.js` calls `decode(dispatchRes.content[0].text)` at line 25 and twice more below, but never imports `decode` (every sibling smoke test — `smoke-test.js`, `poll-smoke-test.js`, `server.test.js` — does). Add it alongside the other imports:

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decode } from "@toon-format/toon";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
```

- [ ] **Step 2: Verify the fix by running the smoke test for real**

`opencode` is installed in this environment, so run the actual integration test rather than a syntax-only check:

```bash
npm run test:integration
```

Expected: `smoke-test.js` and `cancel-smoke-test.js` both run to completion (no `ReferenceError: decode is not defined`), ending with `CANCEL SMOKE TEST PASSED`. (`poll-smoke-test.js` runs after it in the same `npm run test:integration` chain.)

- [ ] **Step 3: Commit**

```bash
git add src/cancel-smoke-test.js
git commit -m "fix(taskferry): import decode in cancel-smoke-test"
```

---

### Task 2: Synchronous cross-process file lock (`src/state-lock.js`)

**Files:**
- Create: `src/state-lock.js`
- Test: `src/state-lock.test.js`

**Interfaces:**
- Produces: `withFileLock(lockPath, fn, { staleMs = 10000, retryMs = 25, timeoutMs = 5000 } = {}) => ReturnType<fn>` — acquires an exclusive lock file at `lockPath` (via `fs.openSync(lockPath, "wx")`), runs `fn()`, and always removes the lock file afterward (even if `fn` throws). Blocks synchronously (via `Atomics.wait`) while another process holds the lock, reclaims a lock file older than `staleMs`, and throws a structured error if `timeoutMs` elapses first.

- [ ] **Step 1: Write the failing tests**

Create `src/state-lock.test.js`:

```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./state-lock.js";

function tmpLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-lock-test-"));
  return path.join(dir, "state.lock");
}

describe("withFileLock()", () => {
  test("runs fn and removes the lock file afterward", () => {
    const lockPath = tmpLockPath();
    const result = withFileLock(lockPath, () => 42);
    assert.equal(result, 42);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("removes the lock file even if fn throws, and rethrows", () => {
    const lockPath = tmpLockPath();
    assert.throws(() => withFileLock(lockPath, () => { throw new Error("boom"); }), /boom/);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("reclaims a stale lock file and proceeds", () => {
    const lockPath = tmpLockPath();
    fs.writeFileSync(lockPath, "");
    const oldMs = Date.now() / 1000 - 3600;
    fs.utimesSync(lockPath, oldMs, oldMs);
    const result = withFileLock(lockPath, () => "ran", { staleMs: 100, retryMs: 10, timeoutMs: 500 });
    assert.equal(result, "ran");
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("throws a structured timeout error when a fresh lock file is never released", () => {
    const lockPath = tmpLockPath();
    fs.writeFileSync(lockPath, "");
    assert.throws(
      () => withFileLock(lockPath, () => "unreachable", { staleMs: 60000, retryMs: 10, timeoutMs: 60 }),
      /error: timed out waiting for lock/
    );
    fs.unlinkSync(lockPath); // test-owned cleanup; withFileLock never acquired it
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/state-lock.test.js`
Expected: FAIL with `Cannot find module './state-lock.js'` (or similar) since the module doesn't exist yet.

- [ ] **Step 3: Implement `src/state-lock.js`**

```javascript
import fs from "node:fs";

// A synchronous, cross-process exclusive lock backed by an exclusively-created
// file. Blocks the event loop via Atomics.wait while contended -- acceptable
// here because tasks.js's own state writes are already synchronous
// (fs.writeFileSync/renameSync) and only ever held for the duration of a
// single small JSON read-modify-write.
export function withFileLock(lockPath, fn, { staleMs = 10000, retryMs = 25, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let ageMs;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statErr) {
        if (statErr.code === "ENOENT") continue; // lock disappeared between attempts
        throw statErr;
      }
      if (ageMs >= staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          if (unlinkErr.code !== "ENOENT") throw unlinkErr;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`error: timed out waiting for lock: ${lockPath}\nhelp: another taskferry process may be stuck; remove the lock file if it is stale`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/state-lock.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/state-lock.js src/state-lock.test.js
git commit -m "feat(taskferry): add synchronous cross-process file lock"
```

---

### Task 3: Locked, merge-based `persistTask()` in `tasks.js`

**Files:**
- Modify: `src/tasks.js:1-10` (import), `src/tasks.js:158-172` (`persist`), and every call site listed below.
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `withFileLock` from `./state-lock.js` (Task 2).
- Produces: `persistTask(taskId)` — replaces `persist()`. Every existing call site that mutates a single task (`dispatch`, `summarizeTask`, `startTask`'s spawn-success/exit/error/catch, `cancel`'s queued and running branches) already has that task's `id` in scope; each becomes `persistTask(task.id)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.test.js` (new `describe` block, near the top-level scope so it can construct two managers against the same directory):

```javascript
describe("persistTask() durability across concurrent manager instances", () => {
  test("two manager instances writing concurrently both keep their own task record", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
    const mgrA = createTaskManager({
      stateDir,
      spawnFn: () => fakeChild(1001),
      killFn: () => { throw new Error("not used"); },
    });
    const mgrB = createTaskManager({
      stateDir,
      spawnFn: () => fakeChild(1002),
      killFn: () => { throw new Error("not used"); },
    });
    const a = mgrA.dispatch({ prompt: "from A", directory: os.tmpdir() });
    const b = mgrB.dispatch({ prompt: "from B", directory: os.tmpdir() });

    const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, "tasks.json"), "utf8"));
    const ids = onDisk.map((t) => t.id);
    assert.ok(ids.includes(a.id), "manager A's task must survive manager B's write");
    assert.ok(ids.includes(b.id), "manager B's task must survive manager A's write");
  });

  test("malformed tasks.json surfaces as a structured error instead of throwing at construction", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
    fs.writeFileSync(path.join(stateDir, "tasks.json"), "{ not valid json");
    const mgr = createTaskManager({ stateDir, spawnFn: () => fakeChild(), killFn: () => {} });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir() }),
      /error: could not read persisted task state/
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: the first new test FAILs — with today's whole-map `persist()`, manager B's write (based on its own in-memory `Map`, which never saw manager A's task) overwrites manager A's task out of `tasks.json`. The second test currently already passes (it's exercising existing `ensureStateLoaded()` behavior) — confirm that, then proceed.

- [ ] **Step 3: Replace `persist()` with locked, merge-based `persistTask()`**

Add the import at the top of `src/tasks.js`:

```javascript
import { withFileLock } from "./state-lock.js";
```

Add `LOCK_FILE` next to the other path constants (`src/tasks.js:88-90`):

```javascript
  const LOG_DIR = path.join(stateDir, "logs");
  const SUMMARY_DIR = path.join(stateDir, "summaries");
  const TASKS_FILE = path.join(stateDir, "tasks.json");
  const LOCK_FILE = path.join(stateDir, "tasks.lock");
```

Replace the `persist()` function (`src/tasks.js:158-172`) with:

```javascript
  function persistTask(taskId) {
    withFileLock(LOCK_FILE, () => {
      let current = [];
      try {
        current = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      const byId = new Map(current.map((t) => [t.id, t]));
      const local = tasks.get(taskId);
      if (local) byId.set(taskId, local);
      else byId.delete(taskId);
      const all = Array.from(byId.values());
      const temporary = path.join(stateDir, `.tasks-${randomUUID()}.json`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, TASKS_FILE);
        fs.chmodSync(TASKS_FILE, 0o600);
      } finally {
        try {
          fs.unlinkSync(temporary);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }
    });
  }
```

Then replace every `persist();` call site with `persistTask(task.id);` (each is already inside a scope where `task` is the single task just mutated):

- `src/tasks.js:248` (inside `dispatch`, after `tasks.set(id, task)`)
- `src/tasks.js:392` (inside `summarizeTask`, after `tasks.set(id, task)`)
- `src/tasks.js:468` (inside `startTask`, after `task.status = "running"`)
- `src/tasks.js:482` (inside the `child.on("exit", ...)` handler)
- `src/tasks.js:491` (inside the `child.on("error", ...)` handler)
- `src/tasks.js:502` (inside `startTask`'s synchronous spawn-failure `catch` block)
- `src/tasks.js:526` (inside `cancel`, queued-task branch)
- `src/tasks.js:542` (inside `cancel`, running-task branch, before `sendSignal`)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js src/state-lock.test.js`
Expected: PASS, including both new tests and every pre-existing test (persistence behavior is unchanged for a single manager instance).

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "fix(taskferry): make tasks.json writes locked and merge-based"
```

---

### Task 4: Active-task concurrency cap (`TASKFERRY_MAX_CONCURRENT_TASKS`)

**Files:**
- Modify: `src/tasks.js:51-93` (config), `src/tasks.js:407-424` (`launchQueuedTasks`), `src/tasks.js:426-506` (`startTask`).
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: a real cap on simultaneously-`running` children, independent of the existing `dispatchLimit`/`dispatchWindow` burst-rate control. `createTaskManager({ maxConcurrentTasks })` is the injectable override tests use (mirrors `maxDispatchesPerWindow`).

- [ ] **Step 1: Write the failing test**

Add to `src/tasks.test.js`, near the existing dispatch-window tests:

```javascript
describe("active-task concurrency cap (independent of the launch-rate window)", () => {
  test("starts at most maxConcurrentTasks children; a 5th stays queued until one finishes", () => {
    const children = [];
    const mgr = makeManager({
      spawnFn: () => {
        const c = fakeChild(9000 + children.length);
        children.push(c);
        return c;
      },
      maxConcurrentTasks: 4,
      maxDispatchesPerWindow: 10, // wide open, so only the concurrency cap is under test
      dispatchWindowMs: 60000,
    });
    const dispatched = Array.from({ length: 5 }, (_, i) => mgr.dispatch({ prompt: `p${i}`, directory: os.tmpdir() }));
    const statuses = () => dispatched.map((d) => mgr.status(d.id).status);
    assert.deepEqual(statuses(), ["running", "running", "running", "running", "queued"]);

    children[0].emit("exit", 0, null);
    assert.deepEqual(statuses(), ["done", "running", "running", "running", "running"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/tasks.test.js`
Expected: FAIL — today all 5 tasks start immediately (subject only to the rate window), so `statuses()` is `["running","running","running","running","running"]` before the exit, not `[...,"queued"]`.

- [ ] **Step 3: Implement the concurrency cap**

Add the env-derived default near the other `DEFAULT_*` constants (`src/tasks.js:51-62`):

```javascript
const DEFAULT_MAX_CONCURRENT_TASKS = positiveInteger(
  Number(process.env.TASKFERRY_MAX_CONCURRENT_TASKS),
  4
);
```

Add the constructor option and derived value (`src/tasks.js:69-93`):

```javascript
export function createTaskManager({
  // ...existing options...
  maxConcurrentTasks = DEFAULT_MAX_CONCURRENT_TASKS,
} = {}) {
  // ...existing body...
  const concurrencyLimit = positiveInteger(maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS);
  let runningCount = 0;
```

Replace `launchQueuedTasks()` (`src/tasks.js:407-424`):

```javascript
  function launchQueuedTasks() {
    launchTimer = null;
    const now = Date.now();
    while (launchTimes.length && launchTimes[0] <= now - dispatchWindow) launchTimes.shift();

    while (launchQueue.length && launchTimes.length < dispatchLimit && runningCount < concurrencyLimit) {
      const id = launchQueue.shift();
      const task = tasks.get(id);
      if (!task || task.status !== "queued") continue;
      launchTimes.push(Date.now());
      startTask(task);
    }

    if (launchQueue.length && !launchTimer) {
      const rateDelay = launchTimes.length >= dispatchLimit ? launchTimes[0] + dispatchWindow - Date.now() : 0;
      const concurrencyDelay = runningCount >= concurrencyLimit ? 250 : 0;
      launchTimer = setTimeout(launchQueuedTasks, Math.max(1, rateDelay, concurrencyDelay));
    }
  }
```

In `startTask()` (`src/tasks.js:426-506`), increment `runningCount` right after a successful spawn, and decrement it (then drain the queue) in both settlement paths and the spawn-failure catch:

```javascript
      task.status = "running";
      task.pid = child.pid;
      runningCount++;
      persistTask(task.id);

      child.on("exit", (code, signal) => {
        // ...existing body...
        persistTask(task.id);
        cleanUpSnapshot();
        runningCount--;
        settleWaiters(task.id);
        launchQueuedTasks();
      });

      child.on("error", (err) => {
        // ...existing body...
        persistTask(task.id);
        cleanUpSnapshot();
        runningCount--;
        settleWaiters(task.id);
        launchQueuedTasks();
      });
```

(The synchronous spawn-failure `catch` block does not touch `runningCount` — the task never reached `"running"`, so it was never incremented.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS, including the pre-existing dispatch-window tests (they set `dispatchWindowMs`/`maxDispatchesPerWindow` but leave `maxConcurrentTasks` at its default of 4, well above their small task counts, so behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(taskferry): cap active running tasks independent of the launch-rate window"
```

---

### Task 5: No-output watchdog (`failureReason: "no_output_timeout"`)

**Files:**
- Modify: `src/tasks.js` (config, `summarize()`, `startTask()`, exit/error handlers).
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `logActivity(logPath)` (existing, `src/tasks.js:584-616`) for its `logHasEvent` check.
- Produces: `task.failureReason` (`null` | `"no_output_timeout"` | `"provider_usage_exhausted"`, the latter added in Task 6), surfaced by `summarize()` and therefore by `status()`/`result()`. `createTaskManager({ noOutputTimeoutMs, watchdogPollMs })` injectable overrides.

- [ ] **Step 1: Write the failing test**

Add to `src/tasks.test.js`:

```javascript
describe("no-output watchdog", () => {
  test("a running child with no parseable log event past the deadline is stopped and marked crashed with failureReason", async () => {
    const child = fakeChild(7001);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    await new Promise((r) => setTimeout(r, 60));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"), "watchdog must SIGTERM the stuck child's process group");

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "no_output_timeout");
  });

  test("a running child that writes a parseable log event before the deadline is left alone", async () => {
    const child = fakeChild(7002);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 30,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "working..." } }) + "\n");

    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(killed, []);
    assert.equal(mgr.status(dispatched.id).status, "running");

    child.emit("exit", 0, null);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — no watchdog exists yet, so `killed` stays empty and `status(dispatched.id).failureReason` is `undefined`, not `null`/`"no_output_timeout"`.

- [ ] **Step 3: Add `failureReason` to the task shape and to `summarize()`**

In `dispatch()`'s task object literal (`src/tasks.js:229-246`) and `summarizeTask()`'s task object literal (`src/tasks.js:372-390`), add:

```javascript
      failureReason: null,
```

In `summarize()` (`src/tasks.js:174-183`):

```javascript
  function summarize(task) {
    const { promptPreview, promptTotalChars, id, status, directory, model, sessionId, pid, startedAt, endedAt, exitCode, signal, logPath, cancelRequested, failureReason } = task;
    return {
      id, status, directory, model, sessionId, pid, startedAt, endedAt, exitCode, signal, logPath,
      failureReason: failureReason ?? null,
      promptPreview,
      ...(promptTotalChars != null ? { promptTotalChars } : {}),
      ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
      cancelRequested: !!cancelRequested,
    };
  }
```

- [ ] **Step 4: Add the watchdog config and helper functions**

Near the other `DEFAULT_*` constants (`src/tasks.js:51-62`):

```javascript
const DEFAULT_NO_OUTPUT_TIMEOUT_MS = positiveInteger(
  Number(process.env.TASKFERRY_NO_OUTPUT_TIMEOUT_MS),
  120000
);
const DEFAULT_WATCHDOG_POLL_MS = positiveInteger(
  Number(process.env.TASKFERRY_WATCHDOG_POLL_MS),
  2000
);
const WATCHDOG_KILL_GRACE_MS = 5000;
```

Add the constructor options alongside `maxConcurrentTasks` (Task 4):

```javascript
export function createTaskManager({
  // ...
  noOutputTimeoutMs = DEFAULT_NO_OUTPUT_TIMEOUT_MS,
  watchdogPollMs = DEFAULT_WATCHDOG_POLL_MS,
} = {}) {
  // ...
  const noOutputTimeout = positiveInteger(noOutputTimeoutMs, DEFAULT_NO_OUTPUT_TIMEOUT_MS);
  const watchdogPoll = positiveInteger(watchdogPollMs, DEFAULT_WATCHDOG_POLL_MS);
  const runningWatchers = new Map(); // taskId -> setInterval handle
```

Add the watchdog tick and stop/fail helpers (near `sendSignal`, `src/tasks.js:556-575`):

```javascript
  function stopRunningWatcher(taskId) {
    const timer = runningWatchers.get(taskId);
    if (timer) {
      clearInterval(timer);
      runningWatchers.delete(taskId);
    }
  }

  // Forces a running task to stop for a reason other than user cancellation
  // (watchdog timeout, or provider-exhaustion detection added in Task 6).
  // Mirrors cancel()'s SIGTERM-then-SIGKILL escalation, but records
  // failureReason instead of cancelRequested so the exit handler's status
  // computation (unchanged) still lands on "crashed", distinguishable from a
  // user-requested "cancelled".
  function failRunningTask(task, failureReason) {
    if (task.failureReason) return; // already stopping this task
    task.failureReason = failureReason;
    stopRunningWatcher(task.id);
    sendSignal(task.pid, "SIGTERM");
    const timer = setTimeout(() => {
      escalationTimers.delete(task.id);
      if (tasks.get(task.id)?.status === "running") sendSignal(task.pid, "SIGKILL");
    }, WATCHDOG_KILL_GRACE_MS);
    escalationTimers.set(task.id, timer);
  }

  function startRunningWatcher(task) {
    const startedAtMs = Date.now();
    const timer = setInterval(() => {
      const current = tasks.get(task.id);
      if (!current || current.status !== "running") {
        stopRunningWatcher(task.id);
        return;
      }
      if (!logActivity(current.logPath).logHasEvent && Date.now() - startedAtMs >= noOutputTimeout) {
        failRunningTask(current, "no_output_timeout");
      }
    }, watchdogPoll);
    runningWatchers.set(task.id, timer);
  }
```

`logActivity` is defined later in the file (`src/tasks.js:584-616`, after `sendSignal`); function declarations are hoisted, so calling it from `startRunningWatcher` above its definition is fine — this already matches the file's existing style (e.g. `status()` calls `logActivity` the same way).

- [ ] **Step 5: Wire the watchdog into `startTask()` and clear it on settlement**

In `startTask()` (`src/tasks.js:426-506`), start the watcher right after `runningCount++` (Task 4):

```javascript
      task.status = "running";
      task.pid = child.pid;
      runningCount++;
      persistTask(task.id);
      startRunningWatcher(task);
```

In both `child.on("exit", ...)` and `child.on("error", ...)`, stop the watcher alongside the existing `escalationTimers` cleanup:

```javascript
      child.on("exit", (code, signal) => {
        stopRunningWatcher(task.id);
        const timer = escalationTimers.get(task.id);
        // ...existing body unchanged...
      });

      child.on("error", (err) => {
        stopRunningWatcher(task.id);
        // ...existing body unchanged...
      });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS, including both new watchdog tests and every prior test (default `noOutputTimeoutMs` is 120s, far longer than any existing synchronous test).

- [ ] **Step 7: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(taskferry): add no-output watchdog with failureReason"
```

---

### Task 6: Provider-usage-exhaustion detection (`failureReason: "provider_usage_exhausted"`)

**Files:**
- Modify: `src/tasks.js` (pattern list, `startRunningWatcher`'s tick body from Task 5).
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: the `runningWatchers` interval infrastructure and `failRunningTask()` from Task 5.
- Produces: `detectProviderExhaustion(rawLogText) => boolean`, and the same interval tick now also stops a task early (before the no-output deadline) when the raw log text matches a known usage-exhaustion pattern.

This is a best-effort classifier built from patterns common across OpenAI/Anthropic/OpenRouter-style provider errors (`rate_limit`, `quota`, `429`, `usage limit`). The design doc's own Current Evidence notes the one real repro seen so far produced *no* output at all (which is exactly the `no_output_timeout` case from Task 5) — this task adds the detector for the case where a provider *does* emit a diagnostic, and Task 10 below is the live-verification step that tunes the pattern list against a real exhausted key once one is available.

- [ ] **Step 1: Write the failing test**

Add to `src/tasks.test.js`:

```javascript
describe("provider-usage-exhaustion detection", () => {
  test("a rate-limit diagnostic in the log stops the child early with failureReason provider_usage_exhausted", async () => {
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
    assert.equal(mgr.status(dispatched.id).failureReason, "provider_usage_exhausted");
  });

  test("ordinary crash text is not misclassified as provider exhaustion", () => {
    const child = fakeChild(7102);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "TypeError: cannot read property 'x' of undefined\n");
    child.emit("exit", 1, null);
    assert.equal(mgr.status(dispatched.id).status, "crashed");
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: the first new test FAILs (nothing checks log content for exhaustion patterns yet, so `killed` stays empty). The second test currently already passes; keep it as a regression guard.

- [ ] **Step 3: Add the pattern list and detector**

Near the other module-level constants (`src/tasks.js:18-24`):

```javascript
const PROVIDER_EXHAUSTION_PATTERNS = [
  /rate.?limit/i,
  /\bquota\b/i,
  /usage.?limit/i,
  /too many requests/i,
  /\b429\b/i,
  /insufficient_quota/i,
];

function detectProviderExhaustion(rawLogText) {
  return PROVIDER_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(rawLogText));
}
```

- [ ] **Step 4: Extend the watchdog tick from Task 5 to check for exhaustion first**

Replace `startRunningWatcher`'s interval body (added in Task 5) with:

```javascript
  function startRunningWatcher(task) {
    const startedAtMs = Date.now();
    const timer = setInterval(() => {
      const current = tasks.get(task.id);
      if (!current || current.status !== "running") {
        stopRunningWatcher(task.id);
        return;
      }
      let raw = "";
      try {
        raw = fs.readFileSync(current.logPath, "utf8");
      } catch {
        raw = "";
      }
      if (raw && detectProviderExhaustion(raw)) {
        failRunningTask(current, "provider_usage_exhausted");
        return;
      }
      if (!raw.trim() && Date.now() - startedAtMs >= noOutputTimeout) {
        failRunningTask(current, "no_output_timeout");
      }
    }, watchdogPoll);
    runningWatchers.set(task.id, timer);
  }
```

(Reading the whole log file on each tick is fine at this scale: logs are capped in practice by task duration and the interval is a few seconds; `readNarrationExcerpt`/`result()` elsewhere in this file already read entire logs synchronously.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS, including both new tests plus the full suite from Tasks 1-5.

- [ ] **Step 6: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(taskferry): detect provider-usage exhaustion from running task logs"
```

---

### Task 7: Key slots for dispatch/advisor tasks (`TASKFERRY_KEY_SLOTS`, `TASKFERRY_PROVIDER_KEY_ENV`, `key_slot`)

**Files:**
- Modify: `src/tasks.js` (config parsing, `dispatch()`, `startTask()`).
- Modify: `src/server.js` (`taskferry_dispatch` input schema).
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `dispatch({ ..., keySlot })` — an optional slot name validated against the configured registry; on success the task carries `keySlot` (name only); at spawn, the *value* of the slot's configured source env var is passed to the child only as `process.env[providerKeyEnvName]`, never persisted or logged. `createTaskManager({ keySlotsSpec, providerKeyEnvName })` injectable overrides (mirroring env-var-derived defaults).

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.test.js`:

```javascript
describe("key slots (dispatch)", () => {
  test("dispatch with an unconfigured key_slot throws before spawning anything", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error("must not spawn"); } });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), keySlot: "primary" }),
      /error: key_slot given but TASKFERRY_PROVIDER_KEY_ENV is not configured/
    );
  });

  test("dispatch with a key_slot name not in the registry throws before spawning anything", () => {
    const mgr = makeManager({
      spawnFn: () => { throw new Error("must not spawn"); },
      keySlotsSpec: "primary:SOME_SOURCE_VAR",
      providerKeyEnvName: "OPENCODE_GO_API_KEY",
    });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), keySlot: "backup" }),
      /error: unknown key_slot: backup/
    );
  });

  test("dispatch with a configured key_slot whose source env var is unset throws before spawning anything", () => {
    delete process.env.AXI_TEST_UNSET_KEY_SOURCE;
    const mgr = makeManager({
      spawnFn: () => { throw new Error("must not spawn"); },
      keySlotsSpec: "primary:AXI_TEST_UNSET_KEY_SOURCE",
      providerKeyEnvName: "OPENCODE_GO_API_KEY",
    });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), keySlot: "primary" }),
      /error: key_slot "primary" source variable AXI_TEST_UNSET_KEY_SOURCE is not set/
    );
  });

  test("a valid key_slot passes only the configured target env var to the spawned child, and only the slot name is persisted", () => {
    process.env.AXI_TEST_KEY_SOURCE = "sk-super-secret-value";
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
      keySlotsSpec: "primary:AXI_TEST_KEY_SOURCE,backup:AXI_TEST_KEY_SOURCE",
      providerKeyEnvName: "OPENCODE_GO_API_KEY",
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), keySlot: "primary" });
    assert.equal(dispatched.keySlot, "primary");
    assert.equal(capturedOpts.env.OPENCODE_GO_API_KEY, "sk-super-secret-value");

    const onDisk = fs.readFileSync(mgr.paths.TASKS_FILE, "utf8");
    assert.ok(!onDisk.includes("sk-super-secret-value"), "the raw key value must never reach tasks.json");
    assert.ok(onDisk.includes('"keySlot": "primary"'));
    delete process.env.AXI_TEST_KEY_SOURCE;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `dispatch()` doesn't accept `keySlot` yet, so the throwing tests instead reach the (still-present) directory checks and spawn unconditionally, and the last test's `dispatched.keySlot` is `undefined` / `capturedOpts.env` is unset.

- [ ] **Step 3: Parse the key-slot registry and add constructor options**

Near the other `DEFAULT_*` constants:

```javascript
function parseKeySlots(spec) {
  const slots = new Map();
  if (!spec) return slots;
  for (const entry of spec.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sepIndex = trimmed.indexOf(":");
    const name = sepIndex === -1 ? "" : trimmed.slice(0, sepIndex).trim();
    const sourceEnvVar = sepIndex === -1 ? "" : trimmed.slice(sepIndex + 1).trim();
    if (!name || !sourceEnvVar) {
      throw new Error(`error: malformed TASKFERRY_KEY_SLOTS entry: ${JSON.stringify(trimmed)}\nhelp: use the form name:ENV_VAR_NAME, comma-separated`);
    }
    slots.set(name, sourceEnvVar);
  }
  return slots;
}
```

Add constructor options alongside the others in `createTaskManager({...})`:

```javascript
export function createTaskManager({
  // ...
  keySlotsSpec = process.env.TASKFERRY_KEY_SLOTS,
  providerKeyEnvName = process.env.TASKFERRY_PROVIDER_KEY_ENV || null,
} = {}) {
  // ...
  const keySlots = parseKeySlots(keySlotsSpec);
```

- [ ] **Step 4: Resolve `key_slot` in `dispatch()` and persist only the name**

Add a resolver near `dispatch()`:

```javascript
  function resolveKeySlot(keySlot) {
    if (keySlot == null) return { keySlot: null, keyEnvValue: null };
    if (!providerKeyEnvName) {
      throw new Error("error: key_slot given but TASKFERRY_PROVIDER_KEY_ENV is not configured\nhelp: set TASKFERRY_PROVIDER_KEY_ENV on the server before using key_slot");
    }
    if (!keySlots.has(keySlot)) {
      throw new Error(`error: unknown key_slot: ${keySlot}\nhelp: configured slots are: ${Array.from(keySlots.keys()).join(", ") || "(none configured)"}`);
    }
    const sourceEnvVar = keySlots.get(keySlot);
    const value = process.env[sourceEnvVar];
    if (!value) {
      throw new Error(`error: key_slot "${keySlot}" source variable ${sourceEnvVar} is not set\nhelp: set ${sourceEnvVar} and restart the taskferry MCP server`);
    }
    return { keySlot, keyEnvValue: value };
  }
```

In `dispatch({ prompt, directory, model, variant, sessionId, keySlot })` (`src/tasks.js:211`), resolve before creating the task, and add `keySlot` to the task object and to `pendingLaunches`:

```javascript
  function dispatch({ prompt, directory, model, variant, sessionId, keySlot }) {
    ensureStateLoaded();
    if (!prompt || typeof prompt !== "string") {
      throw new Error("error: prompt is required\nhelp: taskferry_dispatch requires a non-empty prompt string");
    }
    if (!directory || !path.isAbsolute(directory)) {
      throw new Error(`error: directory must be an absolute path (got ${JSON.stringify(directory)})\nhelp: pass the full path, e.g. "/workspace/my-repo"`);
    }
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error(`error: directory does not exist: ${directory}\nhelp: check the path or create the directory first`);
    }
    const resolvedKeySlot = resolveKeySlot(keySlot);
    // ...id/logPath/usingDefaultModel/resolvedModel unchanged...

    const task = {
      id,
      status: "queued",
      // ...unchanged fields...
      failureReason: null,
      keySlot: resolvedKeySlot.keySlot,
      cancelRequested: false,
    };
    tasks.set(id, task);
    persistTask(id);
    pendingLaunches.set(id, { prompt, directory, model: resolvedModel, variant: task.variant, sessionId, keyEnvValue: resolvedKeySlot.keyEnvValue });
    // ...unchanged...
  }
```

(`resolveKeySlot` throws *before* `tasks.set`/`persistTask`/`pendingLaunches.set`/`launchQueuedTasks`, so an invalid `key_slot` never creates a task or touches `spawnFn` — matching the "fails before spawning" requirement and the Step 1 tests above.)

Add `keySlot` to `summarize()`'s destructure/return alongside `failureReason` (Task 5):

```javascript
    const { /* ... */, failureReason, keySlot } = task;
    return {
      /* ... */,
      failureReason: failureReason ?? null,
      keySlot: keySlot ?? null,
      /* ... */
    };
```

- [ ] **Step 5: Pass the resolved key only into the spawned child's environment**

In `startTask()` (`src/tasks.js:426-506`), build the child's `env` from `launch.keyEnvValue` when present:

```javascript
    let logFd;
    try {
      logFd = fs.openSync(task.logPath, "a", 0o600);
      fs.chmodSync(task.logPath, 0o600);
      const spawnEnv = isSummary
        ? launch.env
        : launch.keyEnvValue != null
          ? { ...process.env, [providerKeyEnvName]: launch.keyEnvValue }
          : undefined;
      const child = spawnFn("opencode", args, {
        cwd: isSummary ? SUMMARY_DIR : launch.directory,
        stdio: ["ignore", logFd, logFd],
        detached: true,
        ...(spawnEnv ? { env: spawnEnv } : {}),
      });
```

- [ ] **Step 6: Add `key_slot` to the MCP tool schema**

In `src/server.js`'s `taskferry_dispatch` registration:

```javascript
    inputSchema: {
      prompt: z.string().describe("The message/prompt to send to opencode."),
      directory: z.string().describe("Absolute path to the working directory opencode should run in (--dir)."),
      model: z.string().optional().describe(
        "provider/model string, e.g. 'opencode-go/minimax-m3' (economy) or 'openai/gpt-5.6-sol' (hard debugging/architecture). Defaults to 'openai/gpt-5.6-luna' --variant high."
      ),
      variant: z.string().optional().describe("Model variant/reasoning effort (e.g. high, max, minimal). Only applied when model is also given."),
      session_id: z.string().optional().describe("Resume an existing opencode session id instead of starting fresh (passes --continue --session)."),
      key_slot: z.string().optional().describe("Name of a preconfigured provider key slot (see TASKFERRY_KEY_SLOTS on the server) to use for this task instead of the server's default credentials."),
    },
  },
  async ({ prompt, directory, model, variant, session_id, key_slot }) => {
    const task = tasks.dispatch({ prompt, directory, model, variant, sessionId: session_id, keySlot: key_slot });
    return toon(task);
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test src/tasks.test.js src/server.test.js`
Expected: PASS, including all four new key-slot tests and the full suite from Tasks 1-6.

- [ ] **Step 8: Commit**

```bash
git add src/tasks.js src/server.js src/tasks.test.js
git commit -m "feat(taskferry): add key_slot selection for dispatched tasks"
```

---

### Task 8: A dedicated key slot for summary tasks (`TASKFERRY_SUMMARY_KEY_SLOT`, `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV`)

**Files:**
- Modify: `src/tasks.js` (config, `summaryEnvironment()`).
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `keySlots` registry from Task 7.
- Produces: `summaryEnvironment()` (existing, `src/tasks.js:42-49`) now also injects the summary provider's key when `TASKFERRY_SUMMARY_KEY_SLOT`/`TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` are configured — independent of whatever `keySlot` (if any) the *source* task used, per the design's "a source task's slot does not implicitly transfer secrets to its summary task."

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.test.js` (near the existing `summarize()` describe block, reusing its log/dispatch fixtures — check that block for how a `done` source task with narration is normally set up, and mirror it):

```javascript
describe("key slots (summary tasks)", () => {
  test("a configured summary key slot is injected into the summary child's env, independent of the source task's own key_slot", async () => {
    process.env.AXI_TEST_SUMMARY_SOURCE = "sk-summary-secret";
    let capturedEnv = null;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      spawnFn: (cmd, args, opts) => { capturedEnv = opts.env; return fakeChild(); },
      keySlotsSpec: "summary-slot:AXI_TEST_SUMMARY_SOURCE",
      summaryKeySlot: "summary-slot",
      summaryProviderKeyEnvName: "DEEPSEEK_API_KEY",
    });
    await mgr.summarize("src1");
    assert.equal(capturedEnv.DEEPSEEK_API_KEY, "sk-summary-secret");
    delete process.env.AXI_TEST_SUMMARY_SOURCE;
  });

  test("an unset summary key slot source variable fails the summary request before spawning", async () => {
    delete process.env.AXI_TEST_SUMMARY_UNSET;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      spawnFn: () => { throw new Error("must not spawn"); },
      keySlotsSpec: "summary-slot:AXI_TEST_SUMMARY_UNSET",
      summaryKeySlot: "summary-slot",
      summaryProviderKeyEnvName: "DEEPSEEK_API_KEY",
    });
    await assert.rejects(() => mgr.summarize("src1"), /error: summary key slot "summary-slot" source variable AXI_TEST_SUMMARY_UNSET is not set/);
  });
});
```

`makeManager()` in the test file needs the two new pass-through options; update its signature and the `createTaskManager` call accordingly:

```javascript
function makeManager({ tasksFixture = [], logs = {}, spawnFn, killFn, listModelsFn, verifySummaryAgentFn, maxDispatchesPerWindow, dispatchWindowMs, advisorSessionTtlMs, maxConcurrentTasks, noOutputTimeoutMs, watchdogPollMs, keySlotsSpec, providerKeyEnvName, summaryKeySlot, summaryProviderKeyEnvName } = {}) {
  // ...unchanged body...
  return createTaskManager({
    stateDir,
    spawnFn: spawnFn ?? (() => { throw new Error("spawnFn was not injected for this test"); }),
    killFn: killFn ?? (() => { throw new Error("killFn was not injected for this test"); }),
    listModelsFn: listModelsFn ?? (() => "opencode-go/deepseek-v4-flash\n"),
    verifySummaryAgentFn: verifySummaryAgentFn ?? (async () => {}),
    ...(maxDispatchesPerWindow != null ? { maxDispatchesPerWindow } : {}),
    ...(dispatchWindowMs != null ? { dispatchWindowMs } : {}),
    ...(advisorSessionTtlMs != null ? { advisorSessionTtlMs } : {}),
    ...(maxConcurrentTasks != null ? { maxConcurrentTasks } : {}),
    ...(noOutputTimeoutMs != null ? { noOutputTimeoutMs } : {}),
    ...(watchdogPollMs != null ? { watchdogPollMs } : {}),
    ...(keySlotsSpec != null ? { keySlotsSpec } : {}),
    ...(providerKeyEnvName != null ? { providerKeyEnvName } : {}),
    ...(summaryKeySlot != null ? { summaryKeySlot } : {}),
    ...(summaryProviderKeyEnvName != null ? { summaryProviderKeyEnvName } : {}),
  });
}
```

(Fold the `maxConcurrentTasks`/`noOutputTimeoutMs`/`watchdogPollMs`/`keySlotsSpec`/`providerKeyEnvName` plumbing into this same edit if Tasks 4-7 didn't already add their piece of it — check `makeManager`'s current signature first and add only what's missing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `summaryEnvironment()` doesn't know about `summaryKeySlot`/`summaryProviderKeyEnvName` yet, so `capturedEnv.DEEPSEEK_API_KEY` is `undefined` and the second test's `summarize()` call resolves instead of rejecting.

- [ ] **Step 3: Add the constructor options and extend `summaryEnvironment()`**

Add options to `createTaskManager({...})`:

```javascript
export function createTaskManager({
  // ...
  summaryKeySlot = process.env.TASKFERRY_SUMMARY_KEY_SLOT || null,
  summaryProviderKeyEnvName = process.env.TASKFERRY_SUMMARY_PROVIDER_KEY_ENV || null,
} = {}) {
```

Replace `summaryEnvironment()` (`src/tasks.js:42-49`):

```javascript
  function summaryEnvironment() {
    const env = { ...process.env };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_DIR;
    delete env.OPENCODE_CONFIG_CONTENT;
    env.OPENCODE_CONFIG_CONTENT = SUMMARY_AGENT_CONFIG;
    if (summaryKeySlot && summaryProviderKeyEnvName) {
      const sourceEnvVar = keySlots.get(summaryKeySlot);
      if (!sourceEnvVar) {
        throw new Error(`error: TASKFERRY_SUMMARY_KEY_SLOT "${summaryKeySlot}" is not a configured key slot\nhelp: add it to TASKFERRY_KEY_SLOTS or fix TASKFERRY_SUMMARY_KEY_SLOT`);
      }
      const value = process.env[sourceEnvVar];
      if (!value) {
        throw new Error(`error: summary key slot "${summaryKeySlot}" source variable ${sourceEnvVar} is not set\nhelp: set ${sourceEnvVar} and restart the taskferry MCP server`);
      }
      env[summaryProviderKeyEnvName] = value;
    }
    return env;
  }
```

`summaryEnvironment()` is called from `summarizeTask()` (`src/tasks.js:353`) before `tasks.set`/`pendingLaunches.set`, so a misconfigured summary slot throws (rejecting the async `summarize()` call) before any task is created or `spawnFn` runs — matching the second test above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS, including both new tests and the full suite from Tasks 1-7.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(taskferry): add a dedicated key slot for summary tasks"
```

---

### Task 9: Documentation — README and tool descriptions

**Files:**
- Modify: `src/server.js` (`taskferry_dispatch`'s `description` string, `src/server.js:20-22`).
- Modify: `README.md` (`#### Launch rate` section at `README.md:64-69`, plus new subsections).

**Interfaces:**
- Consumes: nothing new; this task only updates prose to match Tasks 1-8's behavior.
- Produces: accurate operator-facing documentation. No tests — this is a docs-only task; "verification" is a careful read-through plus grepping for now-inaccurate claims.

- [ ] **Step 1: Fix the `taskferry_dispatch` description's launch-rate claim**

In `src/server.js:20-22`, the current description says the server "starts at most two tasks in each rolling five-second window by default," which (after Task 4) is no longer the concurrency mechanism. Replace it:

```javascript
    description:
      "Queue an `opencode run` for background execution as a directly-spawned child process (no tmux, no shared visibility into the orchestration layer) and return a task_id immediately. At most TASKFERRY_MAX_CONCURRENT_TASKS tasks (default 4) run at once; extra dispatches queue and start FIFO as running tasks finish. A separate, optional launch-rate window (TASKFERRY_MAX_DISPATCHES_PER_WINDOW/TASKFERRY_DISPATCH_WINDOW_MS) can further throttle bursts but is not a concurrency limit. After dispatching, call taskferry_poll to block until the task finishes or times out; if it times out, call taskferry_tail to read the latest output and report the task's current status to the user. Once the task is done, call taskferry_result to fetch the final result.",
```

- [ ] **Step 2: Update the README's `#### Launch rate` section and add new subsections**

In `README.md`, replace the `#### Launch rate` section (`README.md:64-69`):

```markdown
#### Concurrency and launch rate

- `TASKFERRY_MAX_CONCURRENT_TASKS`: maximum number of tasks allowed to be
  `running` at once. Defaults to `4`. Extra dispatches queue and start FIFO
  as running tasks finish, are cancelled, fail to spawn, or hit the
  no-output watchdog.
- `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` / `TASKFERRY_DISPATCH_WINDOW_MS`: an
  independent, optional burst-rate control — at most this many *launches*
  per rolling window (defaults `2` per `5000`ms). This is not a concurrency
  cap; use `TASKFERRY_MAX_CONCURRENT_TASKS` for that.
- `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` (default `120000`): a running task that
  writes no parseable log event before this deadline is stopped (`SIGTERM`,
  escalating to `SIGKILL`) and marked `crashed` with `failureReason:
  "no_output_timeout"`.
- `TASKFERRY_WATCHDOG_POLL_MS` (default `2000`): how often the no-output and
  provider-usage-exhaustion checks run against a running task's log.
- A task stopped because its log matched a known provider-usage-exhaustion
  diagnostic (rate limit, quota, `429`, ...) instead gets `failureReason:
  "provider_usage_exhausted"` — distinct from a bare timeout so a caller
  knows to pick another key slot or model rather than just retrying.

#### Key slots

- `TASKFERRY_KEY_SLOTS`: a comma-separated registry mapping a slot name to
  the *source* environment variable holding that key, e.g.
  `TASKFERRY_KEY_SLOTS=primary:OPENCODE_GO_API_KEY,backup:OPENCODE_GO_API_KEY_BACKUP`.
- `TASKFERRY_PROVIDER_KEY_ENV`: the environment variable name the `opencode`
  child actually reads for its provider key (e.g. `OPENCODE_GO_API_KEY`).
  The selected slot's source value is copied into *this* variable in the
  child's environment only — never into task state, logs, prompts, or tool
  output.
- Pass `key_slot` to `taskferry_dispatch` to pick a configured slot for that
  task. An unconfigured, unknown, or unset-source slot fails immediately,
  before anything spawns.
- `TASKFERRY_SUMMARY_KEY_SLOT` / `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV`:
  the separate key slot and target variable used for `taskferry_summary`'s
  DeepSeek child. A source task's own `key_slot` never transfers to its
  summary task.
- The MCP server only sees environment values present at its own startup;
  restart it after changing any of these variables.
```

- [ ] **Step 3: Update `taskferry_status`'s field list to mention `failureReason` and `keySlot`**

In `README.md`'s `### taskferry_status(task_id)` section (`README.md:116-122`), add a sentence:

```markdown
`failureReason` is `null` unless the task was stopped by the no-output
watchdog (`"no_output_timeout"`) or provider-usage-exhaustion detection
(`"provider_usage_exhausted"`). `keySlot` echoes the `key_slot` name the
task was dispatched with, or `null`.
```

- [ ] **Step 4: Verify by re-reading the diff**

```bash
git diff README.md src/server.js
```

Confirm no remaining reference in either file claims the launch-rate window is a concurrency cap, and that every new env var above actually matches the constructor option name introduced in Tasks 4-8 (`noOutputTimeoutMs`, `watchdogPollMs`, `keySlotsSpec`, `providerKeyEnvName`, `summaryKeySlot`, `summaryProviderKeyEnvName`, `maxConcurrentTasks`).

- [ ] **Step 5: Commit**

```bash
git add README.md src/server.js
git commit -m "docs(taskferry): document concurrency cap, watchdog, and key slots"
```

---

### Task 10: Manual live-verification runbook (gated on real OpenCode Go usage)

**Files:** none (no code changes — this is a manual runbook, matching the design doc's own Tests item 5: "After OpenCode Go usage is available, run a bounded live integration test").

**Interfaces:** none new. This task validates Task 6's `PROVIDER_EXHAUSTION_PATTERNS` against a real exhausted-key response and Task 7's `key_slot` against a real second key, tuning the pattern list if the live signal doesn't already match.

This task cannot be executed unattended in this environment — it requires an actual OpenCode Go account currently past its usage limit, which is external state, not something the plan can set up. Run it once that state exists.

- [ ] **Step 1: Capture the real provider-exhaustion signal**

With an OpenCode Go key known to be over its usage limit, run one bounded request directly (not through taskferry) and capture everything:

```bash
timeout 30 opencode run --dir "$(pwd)" --format json -m opencode-go/minimax-m3 -- "say hi" \
  > /tmp/exhaustion-repro.ndjson 2> /tmp/exhaustion-repro.stderr; echo "exit=$?"
cat /tmp/exhaustion-repro.ndjson /tmp/exhaustion-repro.stderr
```

- [ ] **Step 2: Compare against `PROVIDER_EXHAUSTION_PATTERNS`**

If the captured text matches one of the existing patterns in `src/tasks.js` (`rate.?limit`, `quota`, `usage.?limit`, `too many requests`, `429`, `insufficient_quota`), no code change is needed — add the captured line as a new fixture in `src/tasks.test.js`'s "provider-usage-exhaustion detection" describe block (Task 6) as a regression guard, matching that block's existing test shape, then re-run `node --test src/tasks.test.js`.

If it does *not* match (e.g. the account instead produces the empty-log silence the design doc's Current Evidence originally reported), no new "confirmed exhaustion" signal exists yet — leave `PROVIDER_EXHAUSTION_PATTERNS` alone and confirm instead that `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` (Task 5) correctly classifies that case as `failureReason: "no_output_timeout"` by dispatching the same prompt through `taskferry_dispatch` with a short `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` and polling `taskferry_status`.

- [ ] **Step 3: Verify key-slot execution against a second real key**

With `TASKFERRY_KEY_SLOTS` and `TASKFERRY_PROVIDER_KEY_ENV` configured (server restarted after setting them) and a second, currently-valid key in the `backup` slot's source variable:

```bash
claude mcp add taskferry-livetest \
  -e TASKFERRY_KEY_SLOTS=primary:OPENCODE_GO_API_KEY,backup:OPENCODE_GO_API_KEY_BACKUP \
  -e TASKFERRY_PROVIDER_KEY_ENV=OPENCODE_GO_API_KEY \
  -- node /path/to/taskferry/src/server.js
```

Dispatch one task with `key_slot: "backup"` and confirm (via `taskferry_result`) it completes normally using the backup key, proving slot selection reaches the child process and produces a working run.

- [ ] **Step 4: If Step 2 added a fixture, commit it**

```bash
git add src/tasks.test.js
git commit -m "test(taskferry): add a real provider-exhaustion log fixture"
```

If Step 2 found no new signal (silence, matching the original evidence) or Step 3 needed no code change, there is nothing to commit for this task — record the finding in the PR description / handoff notes instead.

---

## Self-Review Notes

- **Spec coverage:** Provider Failure Detection → Tasks 5, 6, 10. Active-Task Concurrency → Task 4. Key Slots → Tasks 7, 8. Durable Shared State → Tasks 2, 3. Tests and Verification → the `decode` fix is Task 1; unit tests for concurrency/watchdog/cancellation/spawn-failure are Tasks 4-5 plus the pre-existing cancel/spawn-failure tests already in `tasks.test.js`; key-slot leakage tests are Task 7; two-manager persistence and malformed-state tests are Task 3; the live integration test is Task 10.
- **Non-Goals honored:** no secret ever enters `tasks.json`/logs/tool output/args (Tasks 7-8's tests assert this directly); `no_output_timeout` and `provider_usage_exhausted` are always kept as distinct `failureReason` values (Tasks 5-6), never inferred from each other; the launch-rate window is explicitly redocumented as non-concurrency in Task 9 and left functionally independent in Task 4's `launchQueuedTasks()`.
- **Type/name consistency check:** `failureReason` (Task 5) and `keySlot` (Task 7) are both added to the same `summarize()` return object and both flow through `status()`/`poll()`/`advisor()` for free, since those all call `summarize()`. `persistTask(taskId)` (Task 3) is the one rename applied consistently at every former `persist()` call site listed in Task 3 Step 3 — Tasks 4-8 all call `persistTask(task.id)`, never the old `persist()`, when they touch a mutated task.
