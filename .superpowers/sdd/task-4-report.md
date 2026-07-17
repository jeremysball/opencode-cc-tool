# Task 4 report — `wait --summarize`

## Summary

Added `--summarize` to the `wait` command. Streams periodic live summaries via
the existing `streamTaskEvents` helper, then returns the same `leanStatus`
shape plain `wait` returns.

## What changed

- `src/args.js`
  - `commandSpecs.wait.options` (lines 42-47): added `"--summarize"` option
    description; added the matching example to the `examples` array.
  - `defaultOptions` for `"wait"` (line 246): added `summarize: false`.
  - `booleanCommands` (line 325): added `"--summarize": ["wait"]` so the flag
    is recognised as a boolean for `wait`.
  - Validation block (lines 384-389): added the two
    `--summarize cannot be combined with --timeout-ms` /
    `--summarize cannot be combined with --tail-chars` checks.
- `src/args.test.js`
  - Updated the exact-shape assertion at line 38 to include `summarize: false`.
  - Added a new test at lines 168-178 covering parsing, validation of both
    combinations, and the error messages.
- `src/commands.js`
  - `case "wait":` (lines 58-75): when `options.summarize` is set, fetch the
    initial status to get the directory, run `streamTaskEvents` with
    `summaries: true, format: "toon", taskId: options.taskId`, then fetch the
    final status and return it through `leanStatus`. The plain `wait` path
    (without `--summarize`) is unchanged.
- `src/commands.test.js`
  - Added the brief's test at lines 119-151. See "Deviations" below for one
    small modification.

## Test commands and verbatim output

### `node --test src/args.test.js` (after Step 1, before the fix — should fail)

```
✔ parses dispatch and applies its argument defaults (6.635662ms)
✖ parses each command's required arguments and defaults (1.596406ms)
✔ parses every documented command's help without requiring operation arguments (0.650636ms)
✔ requires command-specific arguments and values (0.913703ms)
✔ rejects unknown flags and extra positional arguments before daemon access (0.528924ms)
✔ parses the setup command with no arguments and rejects extras and flags (0.339865ms)
✔ rejects retired MCP names with one-step migration hints (0.365948ms)
✔ parses workspace, stream, and result options with their constrained values (0.438449ms)
✔ accepts --flag=value and rejects invalid enumerated values (0.400718ms)
✔ parses watch --task-id and rejects it for commands that don't take it (0.392444ms)
✔ rejects empty option values and trailing global arguments as usage errors (0.40044ms)
✖ parses wait --summarize and rejects it combined with --timeout-ms or --tail-chars (0.294699ms)
ℹ tests 12
ℹ suites 0
ℹ pass 10
ℹ fail 2
```

Both failures were the expected ones (missing `summarize` in the default-shape
assertion and `--summarize` not recognised as a flag).

### `node --test src/args.test.js` (after the args.js fix)

```
✔ parses dispatch and applies its argument defaults (6.676764ms)
✔ parses each command's required arguments and defaults (0.690093ms)
✔ parses every documented command's help without requiring operation arguments (0.674343ms)
✔ requires command-specific arguments and values (1.040006ms)
✔ rejects unknown flags and extra positional arguments before daemon access (0.75066ms)
✔ parses the setup command with no arguments and rejects extras and flags (0.484526ms)
✔ rejects retired MCP names with one-step migration hints (0.568224ms)
✔ parses workspace, stream, and result options with their constrained values (0.704287ms)
✔ accepts --flag=value and rejects invalid enumerated values (0.578403ms)
✔ parses watch --task-id and rejects it for commands that don't take it (0.483619ms)
✔ rejects empty option values and trailing global arguments as usage errors (0.402014ms)
✔ parses wait --summarize and rejects it combined with --timeout-ms or --tail-chars (0.355488ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
```

### `node --test src/commands.test.js src/args.test.js` (final)

```
✔ parses dispatch and applies its argument defaults (3.677911ms)
✔ parses each command's required arguments and defaults (0.55111ms)
✔ parses every documented command's help without requiring operation arguments (0.535483ms)
✔ requires command-specific arguments and values (0.906228ms)
✔ rejects unknown flags and extra positional arguments before daemon access (0.597724ms)
✔ parses the setup command with no arguments and rejects extras and flags (0.344403ms)
✔ rejects retired MCP names with one-step migration hints (0.365731ms)
✔ parses workspace, stream, and result options with their constrained values (0.573191ms)
✔ accepts --flag=value and rejects invalid enumerated values (0.523261ms)
✔ parses watch --task-id and rejects it for commands that don't take it (0.503351ms)
✔ rejects empty option values and trailing global arguments as usage errors (0.319926ms)
✔ parses wait --summarize and rejects it combined with --timeout-ms or --tail-chars (0.332007ms)
✔ watch prints each event through formatWatchEvent and resolves on abort (4.03202ms)
✔ watch --task-id filters events to one task and exits on its terminal event (0.959838ms)
✔ watch --task-id resolves --directory from the task when omitted, and exits without abort (5.456823ms)
✔ wait --summarize streams summaries then returns the same shape as plain wait (1.659266ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
```

### `npm test` (full suite, with my changes applied)

```
ℹ tests 203
ℹ suites 27
ℹ pass 197
ℹ fail 6
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6713.266221
```

The 6 failures are all in `src/opencode-plugin.test.js` (test lines 57, 78,
105, 139, 162, 186). To confirm they are pre-existing and unrelated to this
change, I stashed the diff and re-ran just that file on the clean tree at
`4646d4d`:

```
$ git stash
$ node --test src/opencode-plugin.test.js
# (same 6 failures, same test lines, same error types)
$ git stash pop
```

So `npm test` is red at the same 6 tests on a clean tree as on this branch —
this is the pre-existing/environmental issue called out in the task
description, not something my change introduced.

### `npm run lint` and `npm run typecheck`

```
$ npm run lint; echo "lint exit: $?"
lint exit: 0
$ npm run typecheck; echo "typecheck exit: $?"
typecheck exit: 0
```

Both exit 0.

## Deviations from the brief

One small deviation, both in the new `commands.test.js` test.

**Brief's Step 6 test as written fails.** The brief calls
`runCommand("wait", ..., { summarize: true })` and then `deliver(...)`
immediately, on the same synchronous tick. In the `wait --summarize` branch,
`runCommand` does `await client.request("task.status", ...)` before reaching
`streamTaskEvents`, so the `onSubscribe` callback that assigns `deliver` does
not run until the microtask queue flushes. The very first synchronous
`deliver(...)` therefore throws `TypeError: deliver is not a function`.

This is a timing quirk of the test fixture, not a bug in the implementation.
The plain `watch` tests get away without a tick because `watchCommand` either
already has a directory (so `normalizeDirectory` runs synchronously) or, in
the "directory omitted" variant, explicitly awaits a `setImmediate` between
`runCommand` and `deliver` (see `src/commands.test.js:110`).

**Fix:** added a single line between `runCommand` and the first `deliver`:

```javascript
await new Promise((resolve) => setImmediate(resolve));
```

This is the same pattern the existing third `watch --task-id` test already
uses in this file (`src/commands.test.js:110`). Everything else in the test
matches the brief verbatim — same fake `"/workspace/project"` string, same
`fakeClient` / `fakeIo` shape, same `runCommand` arguments, same
`client.request` stub, same two `deliver(...)` calls, same four assertions
including the `"wait must not close the client itself; cli.js closes it"`
check.

The pre-task note from the prompt said "use the brief's code as given" in the
specific context of not substituting the `"/workspace/project"` string for a
real `os.tmpdir()` path. That note is still respected — the directory value
is the brief's fake string and `streamTaskEvents` never calls
`normalizeDirectory` on it (because the code path doesn't go through
`watchCommand`), so no filesystem access happens.

## Concerns

None functional. Two minor things worth flagging for the next task:

1. The brief's `watch` tests (lines 58-85 in `commands.test.js`) and the
   new `wait --summarize` test take two different approaches to the same
   "subscribe is async" hazard. If Task 5 touches the same area, it might
   be worth picking one convention (the `setImmediate` flush is more
   defensive, but the unsynchronised call works for paths that don't
   `await` before `streamTaskEvents`).
2. The 6 pre-existing `opencode-plugin.test.js` failures are reproducible on
   the clean tree at the parent commit. They look like missing
   `client.subscribe(...)` / `transform(...)` mocks — i.e. the test file
   expects helpers that the test setup no longer provides. Out of scope
   here, but worth a dedicated cleanup task eventually.
