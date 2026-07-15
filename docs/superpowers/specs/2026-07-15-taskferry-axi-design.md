# Taskferry AXI CLI Architecture

## Decision

Taskferry replaces its MCP server with a persistent local AXI CLI and daemon. The
daemon owns task processes and persistence. The CLI validates agent input, calls the
daemon, and renders agent-facing output as TOON. Claude Code, OpenCode, and Codex use
their native plugin, hook, or skill mechanisms. No MCP server, MCP tool schema, or
`taskferry setup` command remains in the design.

## 1. Daemon Boundary

The public `taskferry` executable is the agent-facing boundary. It owns strict argument
parsing, command help, workspace normalization, output projection, and exit-code
handling. It does not own task processes. Each command defaults workspace-scoped
operations to the current working directory and normalizes the path with
`fs.realpathSync` before sending it to the daemon.

The private daemon owns the task manager, queue, child processes, persistence, event
sequence, and RPC routing. A short-lived CLI invocation may start or contact the same
daemon; the daemon remains alive after the CLI exits. The client auto-starts the daemon
with a lock, a detached process, bounded connection retries, and actionable startup
errors. On restart, persisted `queued` and `running` tasks become `unknown`, preserving
the existing recovery semantics.

The daemon supports Linux and macOS. Windows support waits for a named-pipe transport.
The project provides no public setup command. Users install each native integration
through that agent's plugin or skill mechanism, not through `taskferry setup`.

### Socket Security

The daemon listens on a Unix socket in a private runtime directory. Directory and file
permissions enforce local-user access:

- State and runtime directories use mode `0700`.
- The socket and state files use mode `0600`.
- The socket location resolves from `TASKFERRY_RUNTIME_DIR`, then
  `XDG_RUNTIME_DIR/taskferry`, then the taskferry state directory's `run/` directory.
- State resolves from `TASKFERRY_STATE_DIR`, then `XDG_STATE_HOME`, then
  `~/.local/state/taskferry`.

The client removes a stale socket only after a health check confirms that no daemon
accepts connections. It never replaces a live daemon's socket. Workspace paths are
normalized before persistence, event emission, filtering, and integration context
generation so equivalent paths share one scope.

## 2. JSON RPC Protocol

The daemon exposes a private, versioned JSON RPC protocol over the Unix socket. Protocol
version `1` is explicit in every envelope. Ordinary calls use one request and response
per connection. `event.subscribe` keeps a connection open and streams event envelopes
until the client disconnects or unsubscribes.

### Envelopes

A request has a caller-chosen identifier, a version, a method, and method parameters:

```json
{
  "version": 1,
  "id": "request-id",
  "method": "task.dispatch",
  "params": {}
}
```

A successful response preserves the request identifier and carries a result:

```json
{
  "version": 1,
  "id": "request-id",
  "ok": true,
  "result": {}
}
```

The `errorResponse` envelope preserves the identifier and provides a stable code,
readable message, and corrective help:

```json
{
  "version": 1,
  "id": "request-id",
  "ok": false,
  "error": {
    "code": "UNKNOWN_TASK",
    "message": "unknown task id: oc_123",
    "help": "Run `taskferry list` to see valid task ids"
  }
}
```

The daemon rejects malformed JSON, unsupported protocol versions, unknown methods, and
invalid parameters as structured errors. The CLI translates those responses into TOON
on stdout and keeps diagnostics on stderr. Protocol version changes require a new
versioned envelope contract; clients never infer compatibility from omitted fields.

### Methods

The RPC method set is private to the CLI and native integrations:

- `system.health`
- `task.dispatch`
- `task.cancel`
- `task.status`
- `task.wait`
- `task.list`
- `task.result`
- `task.tail`
- `task.summary`
- `task.advisor`
- `task.context`
- `event.subscribe`

The daemon filters task queries and event subscriptions by normalized workspace when the
caller supplies a directory. Multiple clients may connect concurrently. Disconnects
remove subscriptions without affecting task processes.

## 3. AXI Command Surface

The CLI is designed for non-interactive agent use. It rejects unknown commands,
arguments, and flags before contacting the daemon. Every command supports concise,
command-specific `--help`; no operation prompts for missing values.

| Command | Purpose |
|---|---|
| `taskferry` | Show live workspace tasks and contextual next actions |
| `taskferry dispatch` | Queue a background OpenCode run |
| `taskferry list` | List workspace tasks with counts |
| `taskferry status <id>` | Return task status and activity |
| `taskferry wait <id>` | Wait for settlement or a timeout |
| `taskferry result <id>` | Return the final model result |
| `taskferry tail <id>` | Return recent model text |
| `taskferry summary <id>` | Produce a report or activity summary |
| `taskferry advisor` | Dispatch and wait for a model consultation |
| `taskferry cancel <id>` | Cancel queued or running work |
| `taskferry watch` | Stream workspace task events |
| `taskferry context` | Produce compact session context |
| `taskferry doctor` | Inspect installation and daemon health |
| `taskferry --version` | Print package and protocol versions |

`wait` names the blocking behavior directly. It replaces the former `poll` vocabulary;
the migration documentation maps the old MCP operation `taskferry_poll` to
`taskferry wait`.

Successful data, explicit empty states, help, and operational errors use structured
TOON on stdout. Stderr is reserved for diagnostics. Exit code `0` means success,
including an idempotent no-op; `1` means an operational error; and `2` means a usage
error. The no-argument view identifies the executable, shows a compact workspace task
dashboard, and gives contextual next actions rather than printing a manual.

## 4. Event Model

Events are workspace-scoped projections of task lifecycle and activity. Each event has
this shape:

```js
{
  sequence,
  type: "task.state" | "task.activity",
  taskId,
  directory,
  status,
  previousStatus,
  occurredAt,
  activity,
  outputWatermark
}
```

`sequence` is monotonically increasing for the daemon lifetime. The daemon emits
`queued` before launch, `running` after the child spawns, and the terminal state after
the child settles. Terminal states include `done`, `crashed`, `cancelled`, and
`unknown`. Repeated persistence cannot emit duplicate transitions.

`task.state` events report transitions immediately. `task.activity` events enrich an
active or terminal task with bounded narration and an output watermark. The daemon
normalizes `directory` before it persists or emits any event. Internal summary jobs are
marked internal and never enter user-facing event streams.

`taskferry watch` subscribes to the current workspace by default. TOON is the default
stream format. NDJSON and single-line Claude monitor output require an explicit format
selection. A subscriber may request activity summaries, but summary generation does
not change lifecycle events or create a second public event API.

## 5. Activity Summaries

Activity summaries are a secondary model-provider call used to compress recent task
narration. They are bounded, cached, and optional. The cache key is:

```text
taskId + status + outputWatermark + summaryModel + maxWords
```

The daemon refreshes running activity only after 4096 additional log bytes or a
terminal transition, with a default minimum interval of 60000 ms controlled by
`TASKFERRY_ACTIVITY_MIN_INTERVAL_MS`. `TASKFERRY_ACTIVITY_SUMMARIES=0` disables model
summaries and selects fallback-only behavior.

Before model output exists, the summary uses the dispatch prompt as context. If the
secondary provider fails, the daemon returns sanitized local activity text. Concurrent
subscribers share one in-flight summary request, and cached summaries serve later
Claude and OpenCode clients. Summary jobs carry the internal marker and remain absent
from visible task event streams. Integrations treat summaries as convenience context,
not as the authoritative task result.

## 6. Native Agent Integrations

Taskferry has no MCP integration. Each supported agent uses its native lifecycle or UI
extension point, while the `taskferry` skill remains the shared discovery and execution
contract.

### Skill Hierarchy

`subagent-driven-development` owns the task-by-task implementation and review
lifecycle: task briefs, worktrees, implementer and reviewer passes, fixes, and final
verification. `taskferry` owns all external worker execution: dispatch, model and
variant selection, status, waiting, results, tail, cancellation, session handling,
advisor consultations, and independent deliverable validation. `CLAUDE.md` selects
taskferry as the default backend for that worker execution.

Taskferry is not an alternative lifecycle to
`subagent-driven-development`. It is the worker backend selected inside that lifecycle.
Separate implementation tasks and reviewers start fresh worker sessions. A fixer may
resume only the implementer session for the same task.

### Claude Code

Claude Code installs a native plugin with a `SessionStart` hook, a taskferry skill, and
a monitor command. The task panel uses the static label `taskferry`; the label does not
change as task state changes. The monitor stream carries one-line state and activity
records, for example `Taskferry(running · oc_ab12): Verifying the server with new env
vars via Playwright`. Session context remains limited to the current
`CLAUDE_PROJECT_DIR` workspace.

The plugin registers no MCP server, commands, agents, channels, or custom tool schema.
Its monitor invokes `taskferry watch --directory "${CLAUDE_PROJECT_DIR}" --format
claude-monitor --summaries`.

### OpenCode

OpenCode uses the native managed plugin hooks `event`, `dispose`, and
`experimental.chat.system.transform`. The plugin subscribes to the daemon once,
closes the subscription through `dispose`, injects active tasks and unseen terminal
transitions into model context, and limits injected rows to five with a count when more
exist.

OpenCode presents live state through dynamic toast titles, such as
`Taskferry(done · oc_ab12)`, and maps active and terminal states to the appropriate
toast variants. A terminal transition becomes consumed only after it enters a model
request. Connection failures go to `client.app.log` and do not break OpenCode. Every
dispatched OpenCode child and summary child receives `TASKFERRY_CHILD=1`; child
processes return an empty plugin hook object to prevent recursive integration setup.

### Codex

Codex uses native `SessionStart` and `UserPromptSubmit` hooks to inject compact,
workspace-scoped task context. It has no persistent monitor surface, so taskferry makes
no live-monitor claim for Codex and provides no toast or task-panel UI. Codex receives
fresh context at session start and before each user turn. Hook enablement follows Codex's
native trust and configuration controls, including `/hooks` and
`[features] hooks = true` when the user has not disabled hooks.

The canonical `skills/taskferry/SKILL.md` generates the distributed Claude Code and
Codex skill copies. Hooks provide ambient state; the skill provides on-demand command
discovery. Neither path creates an MCP server.

## 7. Explicit Non-Goals

- No `taskferry setup` command.
- No MCP server, MCP dependencies, MCP configuration, or MCP tool schemas.
- No Windows transport until named-pipe support exists.
- No second public API for native integrations beyond the CLI and its private daemon.
- No unbounded activity narration or uncached summary calls on every event.
