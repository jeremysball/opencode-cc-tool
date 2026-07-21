# Config file for user-facing options

## Problem

Every tunable option in taskferry is an env var today (`docs/sourcemap.md`'s
env var table). That's fine for a handful of internal knobs, but it's an
awkward way for a user to set "run at most 8 concurrent tasks" or "use this
summary model" persistently — env vars require shell profile edits and don't
version well as a single settings blob. We want a config file for the
options a user actually tunes, while options that are really internal
plumbing (paths, poll intervals, the child-process marker) stay env-only.

## Scope

In scope: a new `config.js` module, a JSON config file, precedence rules,
fail-fast validation, and surfacing config errors on first-run daemon spawn.

Out of scope: a `taskferry config get/set/list` CLI subcommand (hand-edit
the file for now), hot-reload (config is read once at daemon startup, same
as env vars today).

## File location and format

`$XDG_CONFIG_HOME/taskferry/config.json`, defaulting to
`~/.config/taskferry/config.json` when `XDG_CONFIG_HOME` is unset — same
`env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config")` pattern
`setup.js` already uses for the opencode plugin path. JSON, top-level flat
object, all fields optional. Absent file = empty config, not an error.

## Which options move

**Config file** (camelCase keys matching the `createTaskManager` option
names):

| Config key | Existing env var |
|---|---|
| `maxConcurrentTasks` | `TASKFERRY_MAX_CONCURRENT_TASKS` |
| `maxDispatchesPerWindow` | `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` |
| `dispatchWindowMs` | `TASKFERRY_DISPATCH_WINDOW_MS` |
| `noOutputTimeoutMs` | `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` |
| `postOutputNoOutputTimeoutMs` | `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` |
| `summaryModel` | `TASKFERRY_SUMMARY_MODEL` |
| `activitySummariesEnabled` | `TASKFERRY_ACTIVITY_SUMMARIES` |
| `summarizerTimeoutMs` | `TASKFERRY_SUMMARIZER_TIMEOUT_MS` |
| `activityMaxWords` | `TASKFERRY_ACTIVITY_MAX_WORDS` |
| `advisorSessionTtlMs` | `TASKFERRY_ADVISOR_SESSION_TTL_MS` |
| `keySlots` | `TASKFERRY_KEY_SLOTS` |
| `providerKeyEnv` | `TASKFERRY_PROVIDER_KEY_ENV` |
| `summaryKeySlot` | `TASKFERRY_SUMMARY_KEY_SLOT` |
| `summaryProviderKeyEnv` | `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` |

**Stays env-only** (unchanged, no config file equivalent):
`TASKFERRY_STATE_DIR`, `TASKFERRY_RUNTIME_DIR`, `TASKFERRY_SOCKET_PATH`,
`TASKFERRY_WATCHDOG_POLL_MS`, `TASKFERRY_CHILD`. These are process-plumbing
(where state lives, how fast the watchdog polls, a marker the daemon sets on
its own children) rather than something a user tunes for behavior.

## Precedence

Per field: `TASKFERRY_*` env var (if set) > config file value (if present)
> built-in default. This is the same three-tier chain `tasks.js` already
computes per-option, just with a middle tier inserted. Setting the env var
remains a full override — nothing needs to unset a config value to use the
old env-var path, so existing scripts/CI keep working unchanged.

## Validation

Fail-fast. `loadConfig()` throws on:
- malformed JSON
- an unrecognized top-level key
- a field present but the wrong type/shape (e.g. `maxConcurrentTasks: "4"`
  instead of `4`, `keySlots` not matching the existing `name:ENV_VAR_NAME`
  comma-separated grammar `parseKeySlots` already validates)

Error messages follow the existing `error: ...\nhelp: ...` two-line style
used elsewhere in this codebase (e.g. `parseKeySlots`'s malformed-entry
error in `tasks.js`, `args.js`'s flag validation).

A missing file is not an error — `loadConfig()` returns `{}` in that case.

## Surfacing errors on first-run daemon spawn

The daemon is spawned `detached` with `stdio: "ignore"`
(`client.js::spawnDaemon`), so an error thrown inside `daemon.js` at
startup is invisible to the invoking CLI process — today, any daemon
startup failure surfaces only as `ensureDaemonStarted`'s generic "daemon
did not become ready within 5000ms" message after the full timeout window.
That's especially bad for a config typo: the user gets no indication what
was wrong, after a multi-second wait.

Fix: `ensureDaemonStarted()` in `client.js` calls `loadConfig()` itself,
synchronously, before calling `spawnDaemonFn`. A validation error propagates
straight out of `ensureDaemonStarted()` — surfacing in well under a second,
with the real `error:`/`help:` message, before any spawn or timeout wait
begins.

`daemon.js` also calls `loadConfig()` independently at its own startup
(passing the result into `createTaskManager`) — the pre-spawn check in
`client.js` covers the common "first `taskferry` command" path, but the
daemon can also start via self-restart-on-source-change
(`docs/daemon.md#self-restart-on-source-change`) with no CLI in front of
it, so the daemon must still be able to catch and report its own bad
config on that path (crash with the same message, visible via whatever
already surfaces daemon self-restart failures today).

## Testing

- `config.js` unit tests: missing file → `{}`; valid file → parsed object;
  malformed JSON → throws with `error:`/`help:`; unrecognized key → throws;
  wrong-typed field → throws; `keySlots` reuses `parseKeySlots`'s existing
  validation and error text.
- `tasks.js` unit tests: env var still overrides a config value; config
  value used when env var unset; built-in default used when both unset.
- `client.js` unit test: `ensureDaemonStarted` propagates a `loadConfig()`
  error without calling `spawnDaemonFn`.

## Docs

- New `docs/config.md` (or a section in an existing doc): file location,
  full field table, precedence rule, fail-fast behavior, an example
  `config.json`.
- Update `docs/sourcemap.md`'s env var table: mark which vars now have a
  config-file equivalent, and add the currently-missing
  `TASKFERRY_ACTIVITY_MAX_WORDS` row (present in code, absent from that
  table today — unrelated pre-existing doc gap, worth fixing while editing
  that table anyway).
