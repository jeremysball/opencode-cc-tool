# Monitor Session Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop taskferry's Claude Code monitor notifications from crossing between multiple Claude Code windows open on the same project directory, by tagging dispatched tasks with the originating Claude Code session and letting a `claude-monitor`-format watch subscribe to only its own session's tasks.

**Architecture:** Thread an optional `originSessionId` string end-to-end: `dispatch` CLI reads it from `process.env.CLAUDE_CODE_SESSION_ID` and sends it on `task.dispatch`; the task manager stores it on the `Task` record and stamps it onto every event it emits; `watch --format claude-monitor` reads the same env var, sends it on `event.subscribe`, and the daemon's event broadcast drops any event whose `originSessionId` differs from the subscription's. Tasks and subscriptions with no `originSessionId` are unaffected (broadcast to everyone, as today), so the change is purely additive and degrades to current behavior when the env var is absent.

**Tech Stack:** Node.js (no new dependencies), `node:test` + `node:assert/strict` for tests.

## Global Constraints

- No new dependencies.
- Every new/changed line of client-visible behavior must degrade gracefully when `CLAUDE_CODE_SESSION_ID` is unset (today's broadcast-to-everyone behavior), since that env var is undocumented and Anthropic could remove it without notice.
- `--origin-session-id` is a new, distinct flag name from the existing `--session-id` (used by `dispatch`/`advisor` for OpenCode's own resumable session) — do not reuse or overload that flag.
- `--origin-session-id` is only meaningful together with `--format claude-monitor`; reject it with any other `watch` format.
- Run `npm run check` (node --check + eslint + tsc --noEmit) and `npm test` before every commit in this plan.

---

### Task 1: Protocol validation for `originSessionId`

**Files:**
- Modify: `src/protocol.js:90-98` (`task.dispatch` case), `src/protocol.js:136-139` (`event.subscribe` case)
- Test: `src/protocol.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `task.dispatch` and `event.subscribe` RPC params now accept an optional `originSessionId` string field. Later tasks (`tasks.js` `dispatch()`, `daemon.js` subscription handling) rely on this validation already having run before their code sees `params.originSessionId`.

- [ ] **Step 1: Write failing tests**

Add to `src/protocol.test.js` (find the existing `describe`/`test` block that exercises `validParams`/`parseRequestLine` for `task.dispatch` and `event.subscribe` — follow the existing test style in that file, e.g. `parseRequestLine(request("task.dispatch", {...}))`):

```javascript
test("task.dispatch accepts an optional originSessionId string", () => {
  const parsed = parseRequestLine(request("task.dispatch", {
    prompt: "hi",
    directory: "/tmp/project",
    originSessionId: "sess-abc",
  }));
  assert.equal(parsed.params.originSessionId, "sess-abc");
});

test("task.dispatch rejects a non-string originSessionId", () => {
  assert.throws(() => parseRequestLine(request("task.dispatch", {
    prompt: "hi",
    directory: "/tmp/project",
    originSessionId: 42,
  })), /invalid params/i);
});

test("event.subscribe accepts an optional originSessionId string", () => {
  const parsed = parseRequestLine(request("event.subscribe", {
    directory: "/tmp/project",
    originSessionId: "sess-abc",
  }));
  assert.equal(parsed.params.originSessionId, "sess-abc");
});

test("event.subscribe rejects a non-string originSessionId", () => {
  assert.throws(() => parseRequestLine(request("event.subscribe", {
    directory: "/tmp/project",
    originSessionId: 42,
  })), /invalid params/i);
});
```

(Match `request(...)` and the exact thrown-error assertion style already used elsewhere in `src/protocol.test.js` — copy the pattern from a neighboring `task.dispatch`/`event.subscribe` test in that file rather than guessing the helper's exact shape.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/protocol.test.js`
Expected: FAIL — `originSessionId` is currently stripped/rejected by `hasOnly(params, [...])` because it isn't in the allowed key list.

- [ ] **Step 3: Implement**

In `src/protocol.js`, update the `task.dispatch` case (currently lines 90-98):

```javascript
    case "task.dispatch":
      return hasOnly(params, ["prompt", "directory", "model", "variant", "sessionId", "keySlot", "finalMarker", "originSessionId"])
        && isNonEmptyString(params.prompt)
        && isAbsolutePath(params.directory)
        && optional(params.model, isNonEmptyString)
        && optional(params.variant, isNonEmptyString)
        && optional(params.sessionId, isNonEmptyString)
        && optional(params.keySlot, isNonEmptyString)
        && optional(params.finalMarker, isNonEmptyString)
        && optional(params.originSessionId, isNonEmptyString);
```

Update the `event.subscribe` case (currently lines 136-139):

```javascript
    case "event.subscribe":
      return hasOnly(params, ["directory", "summaries", "originSessionId"])
        && isAbsolutePath(params.directory)
        && optional(params.summaries, (value) => typeof value === "boolean")
        && optional(params.originSessionId, isNonEmptyString);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/protocol.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/protocol.js src/protocol.test.js
git commit -m "feat(protocol): accept optional originSessionId on task.dispatch and event.subscribe"
```

---

### Task 2: Task model stores and reports `originSessionId`

**Files:**
- Modify: `src/tasks.js` (`Task` typedef ~lines 21-46, `TaskSummary` typedef ~lines 48-70, `dispatch()` ~lines 765-834, `summarize()` ~lines 682-699, `scheduleActivity()` ~lines 581-598)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `dispatch({ prompt, directory, model, variant, sessionId, keySlot, internal, finalMarker, originSessionId })` — `originSessionId` is a new optional param, validated upstream by Task 1's `protocol.js` change before it reaches here (but `dispatch()` is also called directly in tests, so it must not itself throw on the new field).
- Produces: `Task.originSessionId: string|null` and `TaskSummary.originSessionId: string|null`, readable by `daemon.js` (Task 4) via `task.originSessionId`, and present on every `task.activity` event object emitted from `scheduleActivity`.

- [ ] **Step 1: Write failing tests**

Add to `src/tasks.test.js` near the other `dispatch` tests (e.g. after the block around line 406 `test("dispatch rejects an invalid regex source up front (before queueing)", ...)`):

```javascript
test("dispatch stores originSessionId on the task and its summary", () => {
  const mgr = makeManager({ spawnFn: () => fakeChild() });
  const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), originSessionId: "sess-abc" });
  assert.equal(dispatched.originSessionId, "sess-abc");
  assert.equal(mgr.status(dispatched.id).originSessionId, "sess-abc");
});

test("dispatch without originSessionId stores null", () => {
  const mgr = makeManager({ spawnFn: () => fakeChild() });
  const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
  assert.equal(dispatched.originSessionId, null);
});
```

Add to `src/tasks.test.js` near the `scheduleActivity`/event-emission tests (search the file for `type: "task.activity"` to find the existing block that asserts on activity-event shape, and add alongside it):

```javascript
test("task.activity events carry the dispatching task's originSessionId", async () => {
  const events = [];
  const child = fakeChild();
  const mgr = makeManager({ spawnFn: () => child, onEvent: (event) => events.push(event) });
  const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), originSessionId: "sess-xyz" });
  writeLog(dispatched.logPath, [
    { type: "text", part: { messageID: "m1", text: "working" } },
  ]);
  mgr.status(dispatched.id, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  const activityEvent = events.find((event) => event.type === "task.activity");
  assert.equal(activityEvent?.originSessionId, "sess-xyz");
});
```

(If `writeLog` or the force-refresh trigger used above don't match this file's actual helpers for driving `scheduleActivity`, copy the exact pattern from whichever existing test in `src/tasks.test.js` already asserts on a `task.activity` event's shape — the field being added is `originSessionId`, not the triggering mechanism.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `dispatched.originSessionId` is `undefined` (field doesn't exist yet), and the `task.activity` event has no `originSessionId` key.

- [ ] **Step 3: Implement**

In `src/tasks.js`, add to the `Task` typedef (after the `sessionId` line, currently line 28):

```javascript
 * @property {string|null} sessionId
 * @property {string|null} originSessionId
```

Add to the `TaskSummary` typedef (after its `sessionId` line, currently line 54):

```javascript
 * @property {string|null} sessionId
 * @property {string|null} originSessionId
```

Update the `dispatch()` JSDoc (currently lines 765-776) by adding a new `@param` after `sessionId`:

```javascript
   * @param {string|undefined} [params.sessionId]
   * @param {string|undefined} [params.originSessionId]
```

Update the `dispatch()` signature (currently line 777):

```javascript
  function dispatch({ prompt, directory, model, variant, sessionId, keySlot, internal = false, finalMarker = null, originSessionId }) {
```

Update the task object construction inside `dispatch()` (currently lines 809-832), adding one line after `sessionId: sessionId || null,`:

```javascript
      sessionId: sessionId || null,
      originSessionId: originSessionId || null,
```

Update `summarize()` (currently lines 686-699) to destructure and return `originSessionId`:

```javascript
  function summarize(task) {
    const { promptPreview, promptTotalChars, id, status, directory, model, sessionId, originSessionId, pid, startedAt, endedAt, exitCode, signal, logPath, cancelRequested, keySlot, incomplete, finalMarker } = task;
    return {
      id, status, directory, model, sessionId, originSessionId, pid, startedAt, endedAt, exitCode, signal, logPath,
      ...failureFields(task),
      keySlot: keySlot ?? null,
      promptPreview,
      ...(promptTotalChars != null ? { promptTotalChars } : {}),
      ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
      ...(incomplete === true ? { incomplete: true } : {}),
      ...(finalMarker != null ? { finalMarker } : {}),
      cancelRequested: !!cancelRequested,
    };
  }
```

Update `scheduleActivity()`'s event object (currently lines 588-598), adding `originSessionId` after `directory`:

```javascript
      const event = {
        sequence: ++eventSequence,
        type: "task.activity",
        taskId: task.id,
        directory: scheduledDirectory,
        originSessionId: task.originSessionId ?? null,
        status: scheduledStatus,
        previousStatus: null,
        occurredAt: new Date().toISOString(),
        activity: result.activity,
        outputWatermark: result.outputWatermark,
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): store originSessionId on dispatched tasks and stamp it on activity events"
```

---

### Task 3: `task.state` events carry `originSessionId`

**Files:**
- Modify: `src/events.js` (`EventTask` typedef lines 1-7, `emitState` event object lines 28-38)
- Test: `src/events.test.js`

**Interfaces:**
- Consumes: `task.originSessionId` (set by Task 2's `dispatch()`/task object).
- Produces: `task.state` events now include `originSessionId: string|null`, consumed by Task 4's daemon broadcast filter.

- [ ] **Step 1: Write failing test**

Add to `src/events.test.js` (follow the existing style for constructing a task-like object and calling `createTaskEvents(onEvent).emitState(task)` — search that file for an existing `emitState` test and copy its object-construction pattern):

```javascript
test("emitState includes the task's originSessionId on the emitted event", () => {
  const events = [];
  const { emitState } = createTaskEvents((event) => events.push(event));
  emitState({ id: "t1", directory: "/tmp/project", status: "running", originSessionId: "sess-abc" });
  assert.equal(events[0].originSessionId, "sess-abc");
});

test("emitState defaults originSessionId to null when the task has none", () => {
  const events = [];
  const { emitState } = createTaskEvents((event) => events.push(event));
  emitState({ id: "t1", directory: "/tmp/project", status: "running" });
  assert.equal(events[0].originSessionId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/events.test.js`
Expected: FAIL — `events[0].originSessionId` is `undefined`.

- [ ] **Step 3: Implement**

In `src/events.js`, add to the `EventTask` typedef (after `@property {boolean} [internal]`, currently line 6):

```javascript
 * @property {string|null} [originSessionId]
```

Update the `emitState` event object (currently lines 28-38), adding `originSessionId` after `directory`:

```javascript
    const event = {
      sequence: ++sequence,
      type: "task.state",
      taskId: task.id,
      directory: task.directory,
      originSessionId: task.originSessionId ?? null,
      status: task.status,
      previousStatus: emittedStatus ?? previousStatus,
      occurredAt: new Date().toISOString(),
      activity: null,
      outputWatermark: null,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/events.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/events.js src/events.test.js
git commit -m "feat(events): stamp originSessionId on task.state events"
```

---

### Task 4: Daemon filters broadcast by `originSessionId`

**Files:**
- Modify: `src/daemon.js` (`event.subscribe` handler ~lines 345-354, `onEvent` closure ~lines 284-289)
- Test: `src/daemon.test.js`

**Interfaces:**
- Consumes: `request.params.originSessionId` (validated by Task 1), `event.originSessionId` (set by Tasks 2/3).
- Produces: subscriptions with `originSessionId` set now only receive events whose `originSessionId` matches (or events with no `originSessionId` at all, which still broadcast to everyone — unfiltered subscriptions are unaffected).

- [ ] **Step 1: Write failing test**

Add to `src/daemon.test.js`, modeled directly on the existing `test("supports multiple clients and multiple filtered subscriptions per connection", ...)` (lines 228-258):

```javascript
test("event.subscribe with originSessionId only receives same-origin events, and origin-less events broadcast to everyone", async (t) => {
  const paths = temporaryPaths(t);
  const fake = fakeManagerFactory();
  const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
  t.after(() => daemon.close());
  const first = await openPeer(paths.socketPath);
  const second = await openPeer(paths.socketPath);
  t.after(() => first.close());
  t.after(() => second.close());

  await first.request("sub-first", "event.subscribe", { directory: paths.root, originSessionId: "sess-A" });
  await second.request("sub-second", "event.subscribe", { directory: paths.root, originSessionId: "sess-B" });

  fake.emit({ type: "task.state", taskId: "one", directory: paths.root, status: "running", originSessionId: "sess-A" });
  fake.emit({ type: "task.state", taskId: "two", directory: paths.root, status: "running", originSessionId: "sess-B" });
  fake.emit({ type: "task.state", taskId: "three", directory: paths.root, status: "done" });

  const firstEvents = await first.waitForEvents(2);
  const secondEvents = await second.waitForEvents(2);
  assert.deepEqual(firstEvents.map((message) => message.event.taskId), ["one", "three"]);
  assert.deepEqual(secondEvents.map((message) => message.event.taskId), ["two", "three"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/daemon.test.js`
Expected: FAIL — both peers currently receive all three events (no origin filtering exists yet), so `firstEvents` includes `"two"` and the `waitForEvents(2)` assertions mismatch or time out.

- [ ] **Step 3: Implement**

In `src/daemon.js`, update the `onEvent` closure (currently lines 284-289):

```javascript
  const onEvent = (event) => {
    for (const [subscriptionId, subscription] of subscriptions) {
      if (event.directory !== subscription.directory || subscription.socket.destroyed) continue;
      if (subscription.originSessionId && event.originSessionId && subscription.originSessionId !== event.originSessionId) continue;
      writeMessage(subscription.socket, eventMessage(subscriptionId, event));
    }
  };
```

Update the `event.subscribe` handler (currently lines 345-354), adding `originSessionId` to the stored subscription:

```javascript
            if (request.method === "event.subscribe") {
              const subscriptionId = randomUUID();
              subscriptions.set(subscriptionId, {
                socket,
                directory: normalizeDirectory(request.params.directory),
                summaries: request.params.summaries === true,
                originSessionId: request.params.originSessionId || null,
              });
              updateSummarySubscriptions();
              writeMessage(socket, successResponse(request.id, { subscriptionId }));
              return;
            }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon.js src/daemon.test.js
git commit -m "feat(daemon): filter event broadcasts by originSessionId when both sides set it"
```

---

### Task 5: CLI flag `--origin-session-id`

**Files:**
- Modify: `src/args.js` (help spec ~lines 111-121, `defaultOptions` ~lines 262-263, values map ~lines 340-358, format validation ~line 369, post-parse validation ~lines 396-401, `commandAllows` ~lines 406-421)
- Test: `src/args.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseArgs(["watch", ..., "--origin-session-id", "<id>"]).options.originSessionId: string|undefined`, consumed by Task 6's `commands.js` (`watchCommand`/`streamTaskEvents`).

- [ ] **Step 1: Write failing tests**

Update the existing `deepEqual` assertion in `src/args.test.js` (currently lines 133-145) to include the new default field, since every `watch` options object now carries it:

```javascript
  assert.deepEqual(parseArgs([
    "watch",
    "--directory",
    "/tmp/project",
    "--format",
    "ndjson",
    "--summaries",
  ]).options, {
    directory: "/tmp/project",
    format: "ndjson",
    summaries: true,
    taskId: undefined,
    originSessionId: undefined,
  });
```

Update the existing test at currently lines 159-166 the same way:

```javascript
test("parses watch --task-id and rejects it for commands that don't take it", () => {
  assert.deepEqual(parseArgs(["watch", "--task-id", "oc_1"], { cwd: "/workspace/project" }).options, {
    directory: undefined,
    format: "toon",
    summaries: false,
    taskId: "oc_1",
    originSessionId: undefined,
  });
  assert.throws(() => parseArgs(["status", "oc_1", "--task-id", "oc_2"]), /task id is required|unknown flag/);
});
```

Add new tests near those two:

```javascript
test("parses watch --format claude-monitor --origin-session-id", () => {
  const parsed = parseArgs(["watch", "--format", "claude-monitor", "--origin-session-id", "sess-abc"], { cwd: "/workspace/project" });
  assert.equal(parsed.options.originSessionId, "sess-abc");
  assert.equal(parsed.options.format, "claude-monitor");
});

test("rejects --origin-session-id with any format other than claude-monitor", () => {
  assert.throws(
    () => parseArgs(["watch", "--format", "toon", "--origin-session-id", "sess-abc"]),
    /--origin-session-id requires --format claude-monitor/
  );
  assert.throws(
    () => parseArgs(["watch", "--origin-session-id", "sess-abc"]),
    /--origin-session-id requires --format claude-monitor/
  );
});

test("rejects --origin-session-id for commands other than watch", () => {
  assert.throws(() => parseArgs(["dispatch", "--prompt", "hi", "--origin-session-id", "sess-abc"]), /unknown flag/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/args.test.js`
Expected: FAIL — `--origin-session-id` is an unrecognized flag (not in the `values` map / `commandAllows` list), and the two updated `deepEqual` tests fail because `originSessionId` isn't in `defaultOptions("watch", cwd)` yet.

- [ ] **Step 3: Implement**

In `src/args.js`, update the `watch` help spec (currently lines 111-121):

```javascript
  watch: {
    usage: "taskferry watch [options]",
    description: "Stream task state events for a workspace.",
    options: {
      "--directory <path>": "workspace to watch, defaults to the current workspace",
      "--task-id <id>": "scope the stream to one task; exits automatically once it settles",
      "--format toon|claude-monitor|ndjson": "stream format, default toon",
      "--summaries": "request activity summaries when available",
      "--origin-session-id <id>": "with --format claude-monitor, only stream tasks dispatched with the same origin session id",
    },
    examples: ['taskferry watch', 'taskferry watch --task-id <id> --summaries', 'taskferry watch --format ndjson'],
  },
```

Update `defaultOptions()`'s `watch` case (currently lines 262-263):

```javascript
    case "watch":
      return { directory: undefined, format: "toon", summaries: false, taskId: undefined, originSessionId: undefined };
```

Add to the `values` map (currently lines 340-358), after `"--require-final-marker": "finalMarker",`:

```javascript
      "--require-final-marker": "finalMarker",
      "--origin-session-id": "originSessionId",
```

Add to `commandAllows()`'s `flags` object (currently lines 406-421), updating the `watch` entry:

```javascript
    watch: ["--directory", "--format", "--task-id", "--origin-session-id"],
```

Add a post-parse validation check after the existing `wait`/`summarize` checks (currently lines 396-401, insert immediately after them, before `}`):

```javascript
    if (command === "watch" && options.originSessionId !== undefined && options.format !== "claude-monitor") {
      throw usageError("--origin-session-id requires --format claude-monitor", command);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/args.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "feat(cli): add --origin-session-id flag to watch, gated on --format claude-monitor"
```

---

### Task 6: Wire `originSessionId` through `commands.js`

**Files:**
- Modify: `src/commands.js` (`dispatch` case lines 59-70, `streamTaskEvents` lines 197-240, `watchCommand` lines 242-259)
- Test: `src/commands.test.js`

**Interfaces:**
- Consumes: `process.env.CLAUDE_CODE_SESSION_ID`, `options.originSessionId` (produced by Task 5's `args.js`).
- Produces: `task.dispatch` RPC calls include `originSessionId` when `CLAUDE_CODE_SESSION_ID` is set; `client.subscribe(...)` calls include `originSessionId` when `options.originSessionId` is set.

- [ ] **Step 1: Write failing tests**

Add to `src/commands.test.js`, near the existing `fakeClient`/`watch` tests (copy the `fakeClient`/`fakeIo` setup pattern from the existing `test("watch prints each event through formatWatchEvent and resolves on abort", ...)` at line 30):

```javascript
test("watch forwards originSessionId to client.subscribe when set", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let capturedParams;
  const client = fakeClient({
    onSubscribe: (params) => {
      capturedParams = params;
      controller.abort();
    },
  });
  const io = fakeIo();

  await runCommand("watch", { directory: root, format: "claude-monitor", summaries: false, originSessionId: "sess-abc" }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  assert.equal(capturedParams.originSessionId, "sess-abc");
});

test("watch omits originSessionId from client.subscribe when not set", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let capturedParams;
  const client = fakeClient({
    onSubscribe: (params) => {
      capturedParams = params;
      controller.abort();
    },
  });
  const io = fakeIo();

  await runCommand("watch", { directory: root, format: "toon", summaries: false }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  assert.equal("originSessionId" in capturedParams, false);
});

test("dispatch includes originSessionId from CLAUDE_CODE_SESSION_ID when set", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const previous = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = "sess-env-abc";
  try {
    let capturedParams;
    const client = {
      request: async (method, params) => {
        capturedParams = params;
        return { id: "oc_1" };
      },
    };
    await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root });
    assert.equal(capturedParams.originSessionId, "sess-env-abc");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previous;
  }
});

test("dispatch omits originSessionId when CLAUDE_CODE_SESSION_ID is unset", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const previous = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    let capturedParams;
    const client = {
      request: async (method, params) => {
        capturedParams = params;
        return { id: "oc_1" };
      },
    };
    await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root });
    assert.equal("originSessionId" in capturedParams, false);
  } finally {
    if (previous !== undefined) process.env.CLAUDE_CODE_SESSION_ID = previous;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/commands.test.js`
Expected: FAIL — `capturedParams.originSessionId` is `undefined` in the forwarding tests (dispatch/subscribe don't send it yet).

- [ ] **Step 3: Implement**

In `src/commands.js`, update the `dispatch` case (currently lines 59-70):

```javascript
    case "dispatch": {
      const directory = normalizeDirectory(options.directory || cwd);
      return client.request("task.dispatch", {
        prompt: options.prompt,
        directory,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.keySlot === undefined ? {} : { keySlot: options.keySlot }),
        ...(options.finalMarker === undefined ? {} : { finalMarker: options.finalMarker }),
        ...(process.env.CLAUDE_CODE_SESSION_ID ? { originSessionId: process.env.CLAUDE_CODE_SESSION_ID } : {}),
      });
    }
```

Update `streamTaskEvents()`'s signature and `client.subscribe` call (currently lines 197-213):

```javascript
function streamTaskEvents({ client, io, signal, directory, taskId, summaries, format, originSessionId }) {
  let settle;
  let abortHandler;
  const finished = new Promise((resolve, reject) => {
    let settled = false;
    settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result ?? { directory, watching: false });
    };
    abortHandler = () => settle();
    if (signal?.aborted) {
      settle();
      return;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });
    Promise.resolve(client.subscribe({
      directory,
      ...(summaries ? { summaries: true } : {}),
      ...(originSessionId ? { originSessionId } : {}),
    }, (event) => {
```

(Everything after that line in `streamTaskEvents` is unchanged from the current file.)

Update `watchCommand()`'s call into `streamTaskEvents` (currently lines 248-256):

```javascript
  return streamTaskEvents({
    client,
    io,
    signal,
    directory,
    taskId: options.taskId,
    summaries: options.summaries,
    format: options.format,
    originSessionId: options.originSessionId,
  }).finally(() => {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/commands.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands.js src/commands.test.js
git commit -m "feat(cli): populate originSessionId from CLAUDE_CODE_SESSION_ID on dispatch and watch"
```

---

### Task 7: Plugin monitor command gracefully opts into scoping

**Files:**
- Modify: `integrations/claude/monitors/monitors.json`
- Test: `src/integrations.test.js:20-25` (the `assert.deepEqual(monitors, ...)` block)

**Interfaces:**
- Consumes: `--origin-session-id` flag (Task 5), `${CLAUDE_CODE_SESSION_ID}` (a Claude Code monitor process's inherited environment, per `docs/integrations/claude-code.md`'s "command supports ... any inherited `${ENV_VAR}`").
- Produces: the installed plugin's monitor command, verified byte-for-byte by `src/integrations.test.js`.

- [ ] **Step 1: Update the failing test first**

In `src/integrations.test.js`, update the `assert.deepEqual(monitors, ...)` block (currently lines 27-31):

```javascript
  assert.deepEqual(monitors, [{
    name: "taskferry",
    description: "Taskferry task activity",
    command: 'taskferry watch --directory "${CLAUDE_PROJECT_DIR}" --format claude-monitor --summaries ${CLAUDE_CODE_SESSION_ID:+--origin-session-id "$CLAUDE_CODE_SESSION_ID"}',
  }]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/integrations.test.js`
Expected: FAIL — `monitors.json`'s `command` field doesn't match the new expected string yet.

- [ ] **Step 3: Implement**

Write `integrations/claude/monitors/monitors.json`:

```json
[
  {
    "name": "taskferry",
    "description": "Taskferry task activity",
    "command": "taskferry watch --directory \"${CLAUDE_PROJECT_DIR}\" --format claude-monitor --summaries ${CLAUDE_CODE_SESSION_ID:+--origin-session-id \"$CLAUDE_CODE_SESSION_ID\"}"
  }
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/integrations.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add integrations/claude/monitors/monitors.json src/integrations.test.js
git commit -m "fix(integrations): scope the Claude Code monitor to its own session when possible"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/cli-reference.md` (`taskferry watch [options]` section, currently around lines 231-247)
- Modify: `docs/integrations/claude-code.md` (Monitor bullet, currently lines 69-79)

**Interfaces:**
- Consumes: nothing (docs only, no test coverage — this task is doc-only and has no automated test step).

- [ ] **Step 1: Update `docs/cli-reference.md`**

In the `taskferry watch [options]` flag table (currently lines 236-241), add a row after `--task-id <id>`:

```markdown
| `--directory <path>` | Workspace to watch, defaults to the current workspace |
| `--format toon\|claude-monitor\|ndjson` | Stream format, default `toon` |
| `--summaries` | Request live activity summaries (a secondary model call); see [security.md](security.md) |
| `--task-id <id>` | Scope the stream to one task; `watch` then exits on its own once that task settles, instead of running until interrupted |
| `--origin-session-id <id>` | Requires `--format claude-monitor`. Only stream events from tasks dispatched with the same origin session id, so multiple Claude Code windows in the same workspace don't see each other's task notifications |
```

- [ ] **Step 2: Update `docs/integrations/claude-code.md`**

Replace the Monitor bullet (currently lines 69-79):

```markdown
- **Monitor** (`integrations/claude/monitors/monitors.json`): registers a
  `taskferry` monitor backed by `taskferry watch --directory
  "${CLAUDE_PROJECT_DIR}" --format claude-monitor --summaries
  ${CLAUDE_CODE_SESSION_ID:+--origin-session-id "$CLAUDE_CODE_SESSION_ID"}`.
  This is a long-lived streaming process Claude Code's UI reads from; each
  line is a static `Taskferry(<status> · <id>): <activity>` string, since
  Claude Code's monitor surface displays a fixed label per update rather
  than a dynamic per-task title (compare with OpenCode's dynamic toasts,
  below). `--summaries` means the activity text can include a real
  model-generated summary, not just local narration — see
  [security.md](../security.md#activity-summaries) for what that costs and
  how to disable it. `CLAUDE_CODE_SESSION_ID` is an undocumented env var
  Claude Code sets in the monitor process's environment; when present, it
  scopes notifications to the Claude Code window that dispatched the task,
  so multiple windows open on the same workspace don't see each other's
  task activity. `${VAR:+word}` shell expansion means the flag is simply
  omitted (falling back to today's unscoped, broadcast-to-all behavior) on
  any Claude Code version where the env var isn't set.
```

- [ ] **Step 3: Commit**

```bash
git add docs/cli-reference.md docs/integrations/claude-code.md
git commit -m "docs: document --origin-session-id and the scoped Claude Code monitor"
```

---

### Task 9: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full check suite**

Run: `npm run check`
Expected: PASS (node --check, eslint, tsc --noEmit all clean)

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS (all 13+ test files, including every test added in Tasks 1-7)

- [ ] **Step 3: Manual smoke test (optional, requires a real daemon)**

```bash
node bin/taskferry.js doctor
node bin/taskferry.js dispatch --prompt "echo hi" --directory /tmp
node bin/taskferry.js watch --format claude-monitor --origin-session-id does-not-exist &
sleep 2
node bin/taskferry.js dispatch --prompt "echo hi again" --directory /tmp
sleep 2
```

Expected: the backgrounded `watch --origin-session-id does-not-exist` process prints nothing for either dispatched task (since neither dispatch sets a matching `CLAUDE_CODE_SESSION_ID`-derived origin), confirming the filter suppresses cross-origin events. Kill the backgrounded watch afterward.

---

## Self-Review

**1. Spec coverage:** The user's request covers (a) writing the plan, (b) a Claude-Code-specific option linked to the existing `claude-monitor` format, positioned after `--format claude-monitor` on the command line. Task 5 adds `--origin-session-id` gated to `claude-monitor`; Task 7's `monitors.json` command places it after `--format claude-monitor --summaries` on the line, matching the user's ordering request. Tasks 1-4 cover the protocol/model/event/daemon plumbing the flag depends on; Task 6 covers the two CLI call sites (dispatch auto-population, watch forwarding); Task 8 covers docs; Task 9 is final verification. No spec section is unaddressed.

**2. Placeholder scan:** Reviewed for TBD/TODO/"add appropriate"/"similar to Task N" patterns — none present. Every step shows complete, exact code and exact commands.

**3. Type consistency:** `originSessionId` is used identically as `string|null` (task-stored) or `string|undefined` (RPC params/CLI options) across every task — `Task.originSessionId`, `TaskSummary.originSessionId`, `dispatch({ originSessionId })`, `event.originSessionId`, `subscription.originSessionId`, `options.originSessionId`, and the `--origin-session-id` flag all refer to the same field with consistent naming; no divergent names (e.g. no `sourceSessionId` vs `originSessionId` mismatch) appear anywhere in the plan.
