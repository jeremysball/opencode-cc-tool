# Taskferry Live Task Summarizer Design

## Goal

Give a human running Taskferry from a live terminal a way to watch one task's
progress as periodic, model-generated summaries instead of raw log lines, and
have that view exit on its own the moment the task settles — without adding a
second, parallel live-streaming mechanism alongside the one `watch` already
has.

## Background

Two relevant things already exist and stay untouched by this design:

- `watch --summaries` streams every task-state event for a whole `--directory`
  workspace, live, until interrupted (`Ctrl-C`/`SIGTERM`). It has no way to
  scope to a single task.
- `taskferry summary --style activity` / `wait`'s internal `summarizeActivity`
  produce a cached, bounded-length narration digest via a small configurable
  model (`activityCache.refresh` in `src/activity.js`). This is the summary
  generation itself and needs no changes.

`wait` currently makes one blocking `task.wait` RPC call and returns a single
final status block; it does not stream anything.

## Behavior

### Task scoping: client-side, no protocol change

Every emitted event already carries `taskId` (`src/events.js:31`), so no
daemon or protocol change is needed to scope a stream to one task. The
client subscribes exactly as `watch` does today (workspace-`directory`
scoped) and the shared streaming helper filters locally: it ignores any
event whose `taskId` doesn't match, and when a matching event's `status` is
terminal (`done`, `crashed`, `cancelled`, `unknown`), it resolves its promise
and closes the connection (`client.close()`) itself. The daemon's
subscription bookkeeping (`src/daemon.js`'s `subscriptions` map) is
unchanged — the existing socket-close cleanup path already removes it.

### Shared streaming helper

The subscribe-and-print loop inline in `watchCommand` (`src/commands.js:132`)
is extracted into a shared function (working name `streamTaskEvents`) taking
`{ client, io, signal, directory, taskId?, summaries?, format, onEvent? }` and
returning a promise that resolves once the stream closes: on external
interrupt (`signal` abort) always, and — when `taskId` is set — as soon as an
event for that task carries a terminal `status` (`done`, `crashed`,
`cancelled`, `unknown`), at which point it also calls `client.close()`. Both
consumers below call this one function; neither reimplements
subscribe/print/close logic separately. The optional `onEvent` callback lets
a caller observe the terminating event itself (needed by `wait --summarize`,
below) without re-parsing `formatWatchEvent`'s output.

### `watch --task-id <id>`

New flag on the existing `watch` command. Resolves `--directory` from the
task's known workspace when omitted (via `task.status`). Passes `taskId`
through to `streamTaskEvents` as a client-side filter (see above — no
protocol change). Behavior is otherwise identical to today's `watch
--summaries`, except the command now exits on its own once the one task
settles, rather than requiring interrupt.

### `wait --summarize`

New flag on `wait <id>`. Uses the task id `wait` already takes as its
positional argument and needs no `--timeout-ms` — termination is driven by
the task's real terminal event via the shared streaming subscription, not by
a clamp. When set, `wait` skips the plain single-shot `task.wait` RPC call
and instead calls `streamTaskEvents` with `summaries: true`, printing each
periodic summary line to stdout as it arrives (same live behavior as
`watch`). The terminal event itself only carries `{taskId, directory,
status, ...}`, not the full status shape `wait` returns today, so once
`streamTaskEvents` resolves, `wait --summarize` makes one final
`client.request("task.status", { taskId })` call and returns that through
the same `leanStatus` projection plain `wait` already uses — so scripts and
agents parsing `wait`'s output see no shape change, only human-facing
interactive runs see the interim summary lines.

`wait` without `--summarize` is unchanged: single blocking `task.wait` call,
one final result, no streaming.

## What this does not change

- No new summary-generation logic. `activityCache`, `summaryModel`
  resolution, and the existing `TASKFERRY_ACTIVITY_MIN_INTERVAL_MS` /
  `TASKFERRY_ACTIVITY_SUMMARIES` knobs apply unchanged to both consumers.
- `status`, `result`, `tail`, and `summary` are untouched.
- Agents that omit `--summarize` see identical `wait` behavior to today (the
  already-shipped uncapped blocking wait).

## Testing

- `streamTaskEvents`: resolves on external abort signal; ignores events for
  other task ids when `taskId` is set; resolves and closes the client on a
  matching terminal-status event; prints each (matching) event through the
  existing `formatWatchEvent`.
- `watch --task-id`: directory auto-resolution from task id; exits without
  interrupt once the task settles.
- `wait --summarize`: requires an existing task id (same validation as plain
  `wait`); final resolved shape matches plain `wait`'s `leanStatus` output;
  periodic summary lines appear on stdout before the final block.
