# Taskferry Live Task Summarizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human watch one task's live progress as periodic model-generated summaries and have the view exit on its own when the task settles, via `watch --task-id <id>` and `wait --summarize`, both built on one shared streaming helper.

**Architecture:** Extract the subscribe-and-print loop already inline in `watchCommand` (`src/commands.js`) into a reusable `streamTaskEvents` function. Add client-side task-id filtering to it (every emitted event already carries `taskId` — no daemon or protocol change). Wire two thin call sites: a new `--task-id` flag on `watch`, and a new `--summarize` flag on `wait` that streams then makes one final `task.status` call to return `wait`'s normal shape.

**Tech Stack:** Node.js built-in `node:test`/`node:assert/strict`, no new dependencies.

## Global Constraints

- No protocol or daemon change: `src/daemon.js`, `src/protocol.js`, `src/events.js` are not touched by this plan (per `docs/superpowers/specs/2026-07-17-taskferry-summarizer-design.md`, "Task scoping: client-side, no protocol change").
- `wait` without `--summarize` must behave exactly as it does today (uncapped blocking `task.wait`, no streaming) — verify with existing `tasks.test.js`/`args.test.js` coverage after each task.
- Every new/changed public flag needs a passing `npm run lint` and `npm run typecheck` (JSDoc types, not TypeScript files).
- Run `npm test` after every task; do not move to the next task with a red suite.

---

### Task 1: Extract `streamTaskEvents` from `watchCommand` (behavior-preserving refactor)

**Files:**
- Modify: `src/commands.js:132-159` (current `watchCommand`)
- Create: `src/commands.test.js` (no test file for `commands.js` exists yet)

**Interfaces:**
- Produces: `streamTaskEvents({ client, io, signal, directory, taskId, summaries, format })` → `Promise<{ directory: string, watching: false, event?: object }>`. `taskId` and `summaries` are optional; when `taskId` is omitted, behavior is identical to today's `watchCommand` inner loop (never auto-resolves, only resolves on `signal` abort).
- Consumes: nothing new — same `client.subscribe`/`formatWatchEvent` used by `watchCommand` today.

This task only extracts the existing loop into a named, directly-testable function and proves it behaves identically to today's inline code. `taskId`-filtering behavior is added in Task 2; this task's `streamTaskEvents` accepts the parameter but does not yet act on it.

- [ ] **Step 1: Write a fake client/io harness and a test that pins today's watch behavior**

Create `src/commands.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./commands.js";

function fakeIo() {
  const stdout = [];
  return { stdout: { write: (chunk) => stdout.push(chunk) }, lines: stdout };
}

function fakeClient({ onSubscribe } = {}) {
  const closed = { value: false };
  return {
    closed,
    async request() {
      throw new Error("request() not stubbed for this test");
    },
    async subscribe(params, onEvent) {
      if (onSubscribe) onSubscribe(params, onEvent);
      return "sub-1";
    },
    close() {
      closed.value = true;
    },
  };
}

test("watch prints each event through formatWatchEvent and resolves on abort", async () => {
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: "/workspace/project", format: "toon", summaries: false }, {
    client,
    io,
    signal: controller.signal,
    cwd: "/workspace/project",
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: "/workspace/project", status: "running" });
  controller.abort();
  const result = await pending;

  assert.equal(result.directory, "/workspace/project");
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1);
  assert.match(io.lines[0], /oc_1/);
});
```

- [ ] **Step 2: Run it to confirm it passes against today's unmodified `watchCommand`**

Run: `node --test src/commands.test.js`
Expected: PASS (this step only proves the harness works against existing code, before any refactor)

- [ ] **Step 3: Extract `streamTaskEvents` and rewrite `watchCommand` to call it**

Replace the `watchCommand` function in `src/commands.js` (currently lines 132-159) with:

```javascript
function streamTaskEvents({ client, io, signal, directory, taskId, summaries, format }) {
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
    Promise.resolve(client.subscribe({ directory, ...(summaries ? { summaries: true } : {}) }, (event) => {
      if (taskId && event.taskId !== taskId) return;
      io.stdout.write(`${formatWatchEvent(event, format)}\n`);
    })).catch((error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
  return finished.finally(() => {
    signal?.removeEventListener("abort", abortHandler);
  });
}

async function watchCommand(options, { client, io, signal, cwd }) {
  const directory = normalizeDirectory(options.directory || cwd);
  return streamTaskEvents({
    client,
    io,
    signal,
    directory,
    summaries: options.summaries,
    format: options.format,
  }).finally(() => {
    if (client.close) client.close();
  });
}
```

Note this preserves the exact prior semantics (including `client.close()` on finish) — Task 2 adds the `taskId`/terminal-event behavior on top.

- [ ] **Step 4: Run the new test and the full suite**

Run: `node --test src/commands.test.js && npm test`
Expected: All PASS

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: Both exit 0

- [ ] **Step 6: Commit**

```bash
git add src/commands.js src/commands.test.js
git commit -m "refactor(commands): extract streamTaskEvents from watchCommand"
```

---

### Task 2: Add task-id filtering and terminal-event auto-resolve to `streamTaskEvents`

**Files:**
- Modify: `src/commands.js` (the `streamTaskEvents` function from Task 1)
- Modify: `src/commands.test.js`

**Interfaces:**
- Consumes: `streamTaskEvents` signature from Task 1, unchanged.
- Produces: when `taskId` is set, `streamTaskEvents` resolves as soon as an event with matching `taskId` has a terminal `status` (`done`, `crashed`, `cancelled`, `unknown`), resolving with `{ directory, watching: false, event }`. Non-matching-`taskId` events are never printed. Abort-signal resolution is unchanged from Task 1 (resolves with `{ directory, watching: false }`, no `event` key).

- [ ] **Step 1: Write failing tests for task-id filtering and terminal auto-resolve**

Add to `src/commands.test.js`:

```javascript
test("watch --task-id filters events to one task and exits on its terminal event", async () => {
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: "/workspace/project", format: "toon", summaries: false, taskId: "oc_1" }, {
    client,
    io,
    cwd: "/workspace/project",
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_2", directory: "/workspace/project", status: "running" });
  deliver({ sequence: 2, type: "task.state", taskId: "oc_1", directory: "/workspace/project", status: "running" });
  deliver({ sequence: 3, type: "task.state", taskId: "oc_1", directory: "/workspace/project", status: "done" });

  const result = await pending;
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1, "only the matching task's events should print");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /running/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/commands.test.js`
Expected: FAIL — the pending promise never resolves (test times out or hangs), because `streamTaskEvents` doesn't yet act on `taskId`

- [ ] **Step 3: Add the filtering/resolve logic**

In `src/commands.js`, update `streamTaskEvents`'s subscribe callback (from Task 1):

```javascript
    const TERMINAL_STATUSES = new Set(["done", "crashed", "cancelled", "unknown"]);
    Promise.resolve(client.subscribe({ directory, ...(summaries ? { summaries: true } : {}) }, (event) => {
      if (taskId && event.taskId !== taskId) return;
      io.stdout.write(`${formatWatchEvent(event, format)}\n`);
      if (taskId && TERMINAL_STATUSES.has(event.status)) {
        settle({ directory, watching: false, event });
      }
    })).catch((error) => {
```

Move the `TERMINAL_STATUSES` constant to module scope (top of `src/commands.js`, alongside the existing imports) rather than redeclaring it inside the function on every call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/commands.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: All exit 0

- [ ] **Step 6: Commit**

```bash
git add src/commands.js src/commands.test.js
git commit -m "feat(commands): filter streamTaskEvents to one task and auto-resolve on its terminal event"
```

---

### Task 3: Add `watch --task-id <id>`

**Files:**
- Modify: `src/args.js` (commandSpecs.watch, defaultOptions, commandAllows, migration-guard exemption, values map)
- Modify: `src/args.test.js`
- Modify: `src/cli.js:66-73` (directory pre-normalization)
- Modify: `src/commands.js` (`watchCommand`)
- Modify: `src/commands.test.js`

**Interfaces:**
- Consumes: `streamTaskEvents` from Task 2, `client.request("task.status", { taskId })` (existing RPC, already used elsewhere in `commands.js`).
- Produces: `taskId` becomes a recognized `options` key for the `watch` command, resolved through the same `taskId` value already used by `cancel`/`wait`/`status`/`tail`/`summary`/`result`.

- [ ] **Step 1: Write failing args tests**

Add to `src/args.test.js`:

```javascript
test("parses watch --task-id and rejects it for commands that don't take it", () => {
  assert.deepEqual(parseArgs(["watch", "--task-id", "oc_1"], { cwd: "/workspace/project" }).options, {
    directory: undefined,
    format: "toon",
    summaries: false,
    taskId: "oc_1",
  });
  assert.throws(() => parseArgs(["status", "oc_1", "--task-id", "oc_2"]), /task id is required|unknown flag/);
});
```

Update the existing exact-shape assertion at `src/args.test.js:126-137` (the `watch --directory ... --summaries` test) to include the new `taskId` key:

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
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/args.test.js`
Expected: FAIL — `taskId` key missing from `watch`'s options, and `--task-id` is rejected by the generic MCP-migration guard

- [ ] **Step 3: Update `src/args.js`**

In `commandSpecs.watch.options` (around line 108-112), add the new flag to the help text:

```javascript
  watch: {
    usage: "taskferry watch [options]",
    description: "Stream task state events for a workspace.",
    options: {
      "--directory <path>": "workspace to watch, defaults to the current workspace",
      "--task-id <id>": "scope the stream to one task; exits automatically once it settles",
      "--format toon|claude-monitor|ndjson": "stream format, default toon",
      "--summaries": "request activity summaries when available",
    },
    examples: ['taskferry watch', 'taskferry watch --task-id <id> --summaries', 'taskferry watch --format ndjson'],
  },
```

In `defaultOptions` (around line 255-256), change:

```javascript
    case "watch":
      return { directory: cwd, format: "toon", summaries: false };
```

to:

```javascript
    case "watch":
      return { directory: undefined, format: "toon", summaries: false, taskId: undefined };
```

In `parseArgs`, exempt `watch` from the generic `--task-id` migration-error guard (around line 307-314) by adding one condition to the existing check — the thrown message and help text for every other command stay exactly as they are today:

```javascript
    const migrationFlags = {
      "--task-id": "--task-id was replaced by the positional task id; use `taskferry status <id>`",
      "--timeout_ms": "--timeout_ms was renamed; use --timeout-ms",
      "--tail_chars": "--tail_chars was renamed; use --tail-chars",
      "--max_words": "--max_words was renamed; use --max-words",
      "--session_id": "--session_id was renamed; use --session-id",
    };
    if (migrationFlags[name] && !(name === "--task-id" && command === "watch")) {
      throw new UsageError(`unknown flag ${name} for \`${command}\``, migrationFlags[name]);
    }
```

In the `values` map (around line 330-346), add:

```javascript
      "--task-id": "taskId",
```

In `commandAllows` (around line 382-396), add `"--task-id"` to `watch`'s allowed flags:

```javascript
    watch: ["--directory", "--format", "--task-id"],
```

- [ ] **Step 4: Run args tests**

Run: `node --test src/args.test.js`
Expected: PASS

- [ ] **Step 5: Update `src/cli.js`'s directory pre-normalization to skip watch when task-id-only**

In `src/cli.js` (around line 66-73), change:

```javascript
    if (parsed.command === "home"
      || parsed.command === "dispatch"
      || parsed.command === "advisor"
      || parsed.command === "watch"
      || parsed.command === "context"
      || (parsed.command === "list" && !parsed.options.all)) {
      parsed.options.directory = normalizeDirectory(parsed.options.directory || cwd);
    }
```

to:

```javascript
    const watchNeedsTaskIdResolution = parsed.command === "watch" && parsed.options.taskId && !parsed.options.directory;
    if (parsed.command === "home"
      || parsed.command === "dispatch"
      || parsed.command === "advisor"
      || (parsed.command === "watch" && !watchNeedsTaskIdResolution)
      || parsed.command === "context"
      || (parsed.command === "list" && !parsed.options.all)) {
      parsed.options.directory = normalizeDirectory(parsed.options.directory || cwd);
    }
```

- [ ] **Step 6: Update `watchCommand` in `src/commands.js` to auto-resolve directory from task id**

```javascript
async function watchCommand(options, { client, io, signal, cwd }) {
  const directory = options.directory
    ? normalizeDirectory(options.directory)
    : options.taskId
      ? normalizeDirectory((await client.request("task.status", { taskId: options.taskId })).directory)
      : normalizeDirectory(cwd);
  return streamTaskEvents({
    client,
    io,
    signal,
    directory,
    taskId: options.taskId,
    summaries: options.summaries,
    format: options.format,
  }).finally(() => {
    if (client.close) client.close();
  });
}
```

- [ ] **Step 7: Write a commands.js test for directory auto-resolution and auto-exit**

Add to `src/commands.test.js`:

```javascript
test("watch --task-id resolves --directory from the task when omitted, and exits without abort", async () => {
  let deliver;
  const client = fakeClient({
    onSubscribe: (params, onEvent) => {
      deliver = onEvent;
      assert.equal(params.directory, "/workspace/from-task");
    },
  });
  client.request = async (method, params) => {
    assert.equal(method, "task.status");
    assert.equal(params.taskId, "oc_9");
    return { directory: "/workspace/from-task" };
  };
  const io = fakeIo();

  const pending = runCommand("watch", { directory: undefined, format: "toon", summaries: false, taskId: "oc_9" }, {
    client,
    io,
    cwd: "/somewhere/else",
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_9", directory: "/workspace/from-task", status: "crashed" });
  const result = await pending;

  assert.equal(result.event.status, "crashed");
  assert.equal(client.closed.value, true);
});
```

- [ ] **Step 8: Run the new test and the full suite**

Run: `node --test src/commands.test.js src/args.test.js && npm test`
Expected: All PASS

- [ ] **Step 9: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: Both exit 0

- [ ] **Step 10: Commit**

```bash
git add src/args.js src/args.test.js src/cli.js src/commands.js src/commands.test.js
git commit -m "feat(cli): add watch --task-id to scope live streaming to one task"
```

---

### Task 4: Add `wait --summarize`

**Files:**
- Modify: `src/args.js` (commandSpecs.wait, defaultOptions, booleanCommands, validation)
- Modify: `src/args.test.js`
- Modify: `src/commands.js` (`wait` case in `runCommand`)
- Modify: `src/commands.test.js`

**Interfaces:**
- Consumes: `streamTaskEvents` (Task 2/3), `client.request("task.status", ...)`, `leanStatus` (already imported in `commands.js`).
- Produces: `wait <id> --summarize` prints periodic summary lines to stdout (via `streamTaskEvents`) then returns the same `leanStatus`-shaped object plain `wait` returns.

- [ ] **Step 1: Write failing args tests**

Add to `src/args.test.js`:

```javascript
test("parses wait --summarize and rejects it combined with --timeout-ms or --tail-chars", () => {
  assert.deepEqual(parseArgs(["wait", "oc_1", "--summarize"]).options, {
    taskId: "oc_1",
    timeoutMs: undefined,
    tailChars: undefined,
    full: false,
    summarize: true,
  });
  assert.throws(() => parseArgs(["wait", "oc_1", "--summarize", "--timeout-ms", "5000"]), /--summarize cannot be combined with --timeout-ms/);
  assert.throws(() => parseArgs(["wait", "oc_1", "--summarize", "--tail-chars", "500"]), /--summarize cannot be combined with --tail-chars/);
});
```

Update the exact-shape assertion at `src/args.test.js:38` to include the new key:

```javascript
  assert.deepEqual(parseArgs(["wait", "oc_1"]).options, { taskId: "oc_1", timeoutMs: undefined, tailChars: undefined, full: false, summarize: false });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/args.test.js`
Expected: FAIL — `summarize` flag not recognized

- [ ] **Step 3: Update `src/args.js`**

`commandSpecs.wait.options` (around line 38-47):

```javascript
  wait: {
    usage: "taskferry wait <id> [options]",
    description: "Wait for a task to settle or return its current status after a timeout.",
    options: {
      "--timeout-ms <number>": "maximum wait in milliseconds",
      "--tail-chars <number>": "include this many trailing text characters on timeout",
      "--full": "include directory, model, and log details",
      "--summarize": "print periodic live summaries while waiting; exits when the task settles",
    },
    examples: ['taskferry wait <id>', 'taskferry wait <id> --timeout-ms 10000 --tail-chars 1000', 'taskferry wait <id> --summarize'],
  },
```

`defaultOptions` (line 243-244):

```javascript
    case "wait":
      return { taskId: undefined, timeoutMs: undefined, tailChars: undefined, full: false, summarize: false };
```

`booleanCommands` (line 316-321), add `wait` to the `--full` sibling list by adding a new entry:

```javascript
    const booleanCommands = {
      "--full": ["wait", "status", "result", "doctor"],
      "--all": ["list"],
      "--wait": ["summary"],
      "--summaries": ["watch"],
      "--summarize": ["wait"],
    };
```

Add validation after the existing task-id-required check (around line 370-377):

```javascript
    if (command === "wait" && options.summarize && options.timeoutMs !== undefined) {
      throw usageError("--summarize cannot be combined with --timeout-ms", command);
    }
    if (command === "wait" && options.summarize && options.tailChars !== undefined) {
      throw usageError("--summarize cannot be combined with --tail-chars", command);
    }
```

- [ ] **Step 4: Run args tests**

Run: `node --test src/args.test.js`
Expected: PASS

- [ ] **Step 5: Update the `wait` case in `src/commands.js`**

Replace the existing `case "wait":` block:

```javascript
    case "wait": {
      if (options.summarize) {
        const initial = await client.request("task.status", { taskId: options.taskId });
        await streamTaskEvents({
          client,
          io,
          signal,
          directory: initial.directory,
          taskId: options.taskId,
          summaries: true,
          format: "toon",
        });
        const detail = await client.request("task.status", { taskId: options.taskId });
        return leanStatus(detail, { full: options.full });
      }
      const detail = await client.request("task.wait", {
        taskId: options.taskId,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.tailChars === undefined ? {} : { tailChars: options.tailChars }),
      });
      return leanStatus(detail, { full: options.full });
    }
```

Note this deliberately does not call `client.close()` after `streamTaskEvents` resolves (unlike `watchCommand`) — `wait`'s follow-up `task.status` call needs the connection open; `cli.js`'s top-level `finally` block already closes every command's client after `runCommand` returns.

- [ ] **Step 6: Write a commands.js test for `wait --summarize`**

Add to `src/commands.test.js`:

```javascript
test("wait --summarize streams summaries then returns the same shape as plain wait", async () => {
  let deliver;
  const statusCalls = [];
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  client.request = async (method, params) => {
    if (method === "task.status") {
      statusCalls.push(params.taskId);
      return statusCalls.length === 1
        ? { directory: "/workspace/project" }
        : { id: "oc_5", status: "done", startedAt: "2026-07-17T00:00:00.000Z", exitCode: 0, signal: null };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const pending = runCommand("wait", { taskId: "oc_5", timeoutMs: undefined, tailChars: undefined, full: false, summarize: true }, {
    client,
    io,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_5", directory: "/workspace/project", status: "running", activity: "reading files" });
  deliver({ sequence: 2, type: "task.state", taskId: "oc_5", directory: "/workspace/project", status: "done" });

  const result = await pending;
  assert.equal(result.id, "oc_5");
  assert.equal(result.status, "done");
  assert.equal(io.lines.length, 2, "both the running and done events should print");
  assert.equal(client.closed.value, false, "wait must not close the client itself; cli.js closes it");
});
```

- [ ] **Step 7: Run the new test and the full suite**

Run: `node --test src/commands.test.js src/args.test.js && npm test`
Expected: All PASS

- [ ] **Step 8: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: Both exit 0

- [ ] **Step 9: Commit**

```bash
git add src/args.js src/args.test.js src/commands.js src/commands.test.js
git commit -m "feat(cli): add wait --summarize for live periodic progress summaries"
```

---

### Task 5: Docs and final verification

**Files:**
- Modify: `docs/cli-reference.md` (`wait` and `watch` sections)
- Modify: `docs/sourcemap.md` ("Things that look like bugs but aren't" — no change needed there, but verify no stale claims)
- Modify: `todo.txt` (mark "LLM progress summaries" done)

**Interfaces:** none — documentation and verification only.

- [ ] **Step 1: Update `docs/cli-reference.md`'s `wait` section**

In the `## \`taskferry wait <id> [options]\`` section, add a row to the flag table and a paragraph after the existing `--timeout-ms`/`--tail-chars`/`--full` table:

```markdown
| `--summarize` | Stream periodic live summaries to stdout while waiting; exits and returns the normal result the moment the task settles. Cannot combine with `--timeout-ms` or `--tail-chars`. |
```

Add below the existing examples block:

```markdown
`--summarize` is for a human watching a live terminal, not for scripts or
agents: the periodic lines print as the wait progresses, and the final
line is the same TOON block plain `wait` always returns, so anything
parsing that final output sees no shape change.
```

- [ ] **Step 2: Update `docs/cli-reference.md`'s `watch` section**

In the `## \`taskferry watch [options]\`` section, add a row:

```markdown
| `--task-id <id>` | Scope the stream to one task; `watch` then exits on its own once that task settles, instead of running until interrupted |
```

Add a sentence after the existing flag table:

```markdown
Without `--task-id`, `watch` streams every task in the workspace until
interrupted. With it, `--directory` is optional — it's resolved from the
task itself when omitted.
```

- [ ] **Step 3: Update `todo.txt`**

Change the "LLM progress summaries (wait --summarize)" entry under `TIER IMPORTANT` from `[_]` to `[X]` with a shipped status line, matching the style of other completed entries in the file (see the `Wait timeout clamp removal` entry for the exact format).

- [ ] **Step 4: Run the full verification suite**

Run: `npm test && npm run lint && npm run typecheck && npm run skill:check`
Expected: All exit 0. If `skill:check` fails, run `npm run skill:generate` and inspect the diff — this feature doesn't change any behavior `skills/taskferry/SKILL.md` documents, so a failure here would indicate an unrelated pre-existing drift, not something this plan introduces.

- [ ] **Step 5: Commit**

```bash
git add docs/cli-reference.md todo.txt
git commit -m "docs: document watch --task-id and wait --summarize"
```
