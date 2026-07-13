# opencode-cc-tool

An MCP server that gives Claude Code a first-class tool for dispatching work
to the `opencode` CLI: launch a background task, get a task handle back
immediately, poll status, and fetch the result. No hand-rolled tmux wrappers,
no grepping logs.

## Why

The `using-opencode` Claude Code skill's documented pattern wraps
`opencode run` in a detached tmux session, then polls with
`until ! tmux has-session ...` and greps the log for completion markers
(`EXIT_CODE=[0-9]`, `exiting loop`, etc). That pattern exists because tmux
was available, not because it's the right tool. It has two real problems.

1. **The dispatched process can see the tmux session managing it.** In
   practice, a dispatched `opencode run` with bash access ran
   `tmux list-sessions`, saw its own wrapping session, mistook it for a
   duplicate run of the same task, and burned several minutes in a
   self-referential polling loop. A retry with an explicit "don't touch
   tmux" instruction succeeded.
2. **Completion detection string-matches raw logs.** Markers like
   `EXIT_CODE=` or `Status: DONE` can appear inside quoted or nested text
   (e.g. a sub-task that echoes another log) and produce false positives.
   The skill documents extensive workarounds for exactly this.

This server sidesteps both. It spawns `opencode run` directly as a child
process, with no tmux and no shared session for it to enumerate, and
determines completion from the child process's real `exit` event, not from
log text.

## Tools

### `opencode_dispatch(prompt, directory, model?, variant?, session_id?)`

Starts `opencode run --dir <directory> --auto --format json -- <prompt>` as
a background child process, with stdout and stderr redirected to a private
per-task log file. Returns a task summary immediately, including `id`,
`status: "running"`, `pid`, and `logPath`.

- `directory` must be an absolute path that exists.
- `model`: any valid `provider/model` string (run `opencode models` to list
  them). Defaults to `openai/gpt-5.6-luna --variant high`, mirroring the
  "recommended" tier in the `using-opencode` skill's Select Model table.
  Pass e.g. `opencode-go/minimax-m3` for the "economy" tier on high-volume,
  lower-stakes work.
- `variant`: reasoning effort override (`high`, `max`, `minimal`, etc.),
  applied only when `model` is also given. The default model always uses
  `high`.
- `session_id`: resume an existing opencode session (`--continue --session
  <id>`) instead of starting fresh. Get session ids from a prior
  `opencode_result` or `opencode_status` response.

### `opencode_wait(task_id, timeout_ms?)`

Blocks until the task's real `exit` event fires, or `timeout_ms` elapses
(capped at 45000 regardless of what's passed, to stay under Claude Code's
own 60s default MCP tool-call timeout), then returns the same status shape
as `opencode_status`. This is the closest available analog to the built-in
Agent tool's auto-resume behavior: call once, get blocked, get a result,
instead of looping on `opencode_status` yourself. If it returns with
`status: "running"`, the task simply outlived the cap; call it again.

### `opencode_cancel(task_id, grace_ms?)`

Stops a running task: sends `SIGTERM` to the task's whole process group
(not just the `opencode` process, so a subprocess it's mid-way through
running, like a long bash command, dies too), escalating to `SIGKILL` after
`grace_ms` (default 5000) if it hasn't exited. Calling it on a task that
already finished is a no-op that returns a `note` instead of an error. The
task's status becomes `"cancelled"` once its exit event lands, distinct
from `"crashed"`.

### `opencode_status(task_id)`

Returns `{ status: "running" | "done" | "crashed" | "cancelled" |
"unknown", exitCode, signal, logPath, ... }`. `status` comes from the child
process's actual exit event (`child.on("exit", ...)`), not from parsing
output. `"unknown"` appears only if the server process restarted while the
task was still running; see Limitations.

### `opencode_result(task_id)`

Once a task is `done` or `crashed`, parses its log (opencode's own
`--format json` NDJSON event stream, one JSON object per line) into two
fields:

- `message`: the model's final turn only, the `text` events belonging to
  the messageID whose `step_finish` reason was `"stop"`. This is the actual
  answer; narration from earlier steps lives in `narration` instead.
- `narration`: every `text` event across every step, in order, separated by
  blank lines. Useful when a run does several tool calls with commentary in
  between and you want the fuller picture, not just the closing line.

A single-step run (no tool calls) has `message === narration`. Also returns
`sessionId`, `tokens`, and `cost` pulled from the `step_finish` events.
Returns a polite "still running" message instead of a partial result if
called too early.

Naively joining every `text` event regardless of step (an earlier version
of this tool did exactly that) glues "I'm about to run `ls`" directly onto
the real answer with no separator, since opencode's steps look like `text`
(narration) → `tool_use` → `step_finish` (`reason: "tool-calls"`) → `text`
(answer) → `step_finish` (`reason: "stop"`). Verified by hand: a prompt
asking opencode to `ls` and report a count produced two `text` events, one
per step; `message` now returns only the second.

### `opencode_list()`

Lists every task known to this server process, newest first.

## Why polling and waiting, not push notifications

The built-in Agent tool notifies Claude Code when a background subagent
finishes; this server can't replicate that for MCP tools in general,
because the relevant MCP mechanism is either unsupported or explicitly
rejected as of mid-2026:

- Generic server-initiated `notifications/message` pushed into the model's
  context: closed as **not planned** by Anthropic
  ([anthropics/claude-code#36665](https://github.com/anthropics/claude-code/issues/36665)).
  MCP's request-response shape means a server can't interrupt the model
  mid-turn to say "your task finished."
- **Channels** ([code.claude.com/docs/en/channels](https://code.claude.com/docs/en/channels))
  are the real, shipped mechanism for pushing events into a live session,
  but they're a heavier fit than they first look: research preview,
  Anthropic-account auth only, built as a Bun plugin rather than a plain
  stdio MCP server, and only active when the session was launched with
  `claude --channels plugin:<name>@<marketplace>`. Being registered via
  `claude mcp add` (how this server is set up) isn't enough on its own;
  channels are a separate registration path. Worth revisiting if this tool
  needs true async push later, but out of scope for now.

`opencode_wait` is the practical middle ground: one blocking call that
resolves the moment the task's exit event fires, capped well under Claude
Code's MCP tool-call timeout so it degrades to a clean "still running"
rather than an error. It gets Agent-tool-like ergonomics (dispatch, then
one call that "just returns when it's done") without depending on a
research-preview feature.

## Design notes

- **Why `--format json` instead of the default formatted output.**
  opencode's default text output mixes ANSI banners and step formatting
  into the reply, which is awkward to parse reliably. `--format json` emits
  one JSON event per line (`step_start`, `text`, `step_finish`, ...) with a
  stable schema, including the `sessionID` needed for `--continue`.
  Confirmed by hand: `opencode run --format json -- "Reply with the word
  PONG and nothing else."` produced clean NDJSON on stdout and empty
  stderr on success.
- **State directory.** Defaults to `~/.opencode-cc-tool`, computed via
  `os.homedir()` rather than hardcoded, overridable with
  `OPENCODE_CC_TOOL_STATE_DIR`. Holds `tasks.json` (task metadata) and
  `logs/<task_id>.ndjson` (raw opencode output per task).
- **Not tmux, but `detached: true`, for a narrower reason than survival.**
  The server holds a direct reference to the child and listens on its
  `exit` event regardless of `detached`; that part doesn't need detaching.
  `detached: true` matters for `opencode_cancel`: it makes the child its
  own process group leader (`pgid === pid`), so `opencode_cancel` can
  signal the whole group with `process.kill(-pid, ...)` and reach a
  subprocess `opencode` spawned (e.g. a bash command it's running), not
  just the `opencode` process itself. Without `detached: true`, the child
  would share this server's own process group, and a group-kill would risk
  taking the server down with it. Isolation from the orchestration layer,
  the actual bug this tool fixes, comes from not launching via tmux at all:
  the child has no session or pane to `tmux list-sessions` its way into,
  independent of the `detached` flag.

## Limitations and follow-ups

- **State survives only for the current server process's lifetime.** If the
  MCP server process restarts while a task is still running, the new
  process has no child-process handle to listen for that task's `exit`
  event (that handle exists only in the process that called `spawn`). On
  reload, the server relabels any task still marked `"running"` in
  `tasks.json` as `"unknown"` instead of reporting a possibly-stale
  `"running"`. The underlying `opencode` process, if still alive, keeps
  running and writing its log: inspect the
  log file directly, or run `opencode session list`, but this server won't
  re-attach a status watcher to it. A follow-up could periodically recheck
  `unknown` tasks' PIDs and tail their logs for a trailing `step_finish` as
  a secondary signal, but that reintroduces string/heuristic matching for
  exactly the crash-recovery edge case, so it's left out for now rather
  than done half right.
- No log rotation or cleanup: `logs/` grows unbounded. Fine for interactive
  use; long-lived automation would want a retention policy.

## Setup

```bash
cd /workspace/opencode-cc-tool
npm install
```

## Register with Claude Code

```bash
claude mcp add opencode-cc-tool -- node /workspace/opencode-cc-tool/src/server.js
```

Use `-s user` instead of the default `-s local` scope to make it available
in every project, or `-s project` to check a `.mcp.json` entry into a
specific repo. To override the state directory:

```bash
claude mcp add opencode-cc-tool -e OPENCODE_CC_TOOL_STATE_DIR=/some/path -- node /workspace/opencode-cc-tool/src/server.js
```

Verify registration:

```bash
claude mcp list
claude mcp get opencode-cc-tool
```

## Smoke tests (standalone, no Claude Code needed)

Each drives the server over stdio using the MCP SDK's `Client`, exactly as
Claude Code would.

```bash
node src/smoke-test.js /workspace/opencode-cc-tool         # dispatch, poll status, fetch result; expects PONG
node src/cancel-smoke-test.js /workspace/opencode-cc-tool  # dispatch a sleep, cancel it, confirm the process group is gone
node src/wait-smoke-test.js /workspace/opencode-cc-tool    # opencode_wait resolving early and hitting its cap
```

Each prints a `... SMOKE TEST PASSED` or `FAILED` line and exits
accordingly.
