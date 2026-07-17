# Todo Coverage Audit — Final

Merges two independently produced audits of the same question: does an
existing plan cover each item in `todo-07-15.txt` and `todo-07-16.txt`?

- `2026-07-16-todo-coverage-matrix.md` — built fresh (gpt-5.6-sol, 2026-07-16
  23:57) by reading both todo files against all six plans and current `main`.
- `2026-07-16-todo-coverage-review.md` — an independent audit (gpt-5.5,
  2026-07-16 23:54) that ran the same audit blind (the matrix didn't exist
  yet at that time) and separately ran `npm test` / `npm run lint` / `npm run
  typecheck` / `git diff --check`.

**Cross-check result: the two audits agree on every row.** No todo item is
marked covered by one and uncovered by the other. The only differences are
cosmetic (row grouping, "partial" vs. a "not covered" header whose body text
says the same thing) — noted inline below and resolved in favor of the more
precise wording. This convergence is treated as strong confirmation the
table below is accurate.

## Coverage Matrix

| Todo item (source file:line) | Covered | Evidence | Notes |
|---|---|---|---|
| Ensure everything is merged (`todo-07-15.txt:1`) | no | `docs/superpowers/plans/2026-07-15-taskferry-brand-prototype.md:22-30`; `docs/superpowers/plans/2026-07-16-taskferry-setup.md:24-33`; `docs/superpowers/plans/2026-07-16-watchdog-output-escalation.md:24-29`; `git branch --all` | No plan task defines an all-work merge deliverable. Reliability, advisor, and AXI CLI work is on `main`; the brand board exists only on `feat/taskferry-brand`; setup/watchdog implementation is still open. |
| Omit the caller-supplied id from poll output; suppress unchanged repeated data (`todo-07-15.txt:2-4`) | no | `src/output.js:57-90`; `src/tasks.js:1316-1349`; `docs/superpowers/plans/2026-07-15-taskferry-axi-cli.md:225-259` | `leanStatus()` always emits `id`; each wait returns a fresh status object. Not a duplicate of the wait-clamp bug at `todo-07-16.txt:4-19` — that's blocking/timeout behavior, this is response shape. |
| Web UI / dataviz / key-admin panel (`todo-07-15.txt:5`) | no | `docs/superpowers/plans/2026-07-15-taskferry-brand-prototype.md:5-9,22-30` | The brand plan produces a static logo review board, not an operational UI or key manager. No matching source under `src/`. |
| Remove old ids from list output (`todo-07-15.txt:6`) | no | `src/tasks.js:1416-1427`; `src/output.js:118-126` | `list()` returns every persisted/in-memory task. `--limit` only slices displayed rows; no plan defines retention/removal. |
| Select tools available to the task runner (`todo-07-15.txt:7`) | no | `src/args.js:16-31`; `src/tasks.js:954-964` | Dispatch has no tool-selection argument; always invokes `opencode run --auto`. |
| Select/reuse/create task-runner agents (`todo-07-15.txt:8-10`) | no | `src/tasks.js:133-134,954-964`; `src/args.js:16-31` | Only the internal `taskferry-summary` agent is fixed in code. No plan adds a public agent-selection input. |
| Default polling interval of 30s (`todo-07-15.txt:11`) | no | `src/tasks.js:125-128,255-257`; `src/args.js:38-46` | Wait calls cap at 45s; the internal watchdog polls every 2s. No plan defines a 30s caller cadence. |
| One-in-flight-request providers (`todo-07-15.txt:12`) | no | `src/tasks.js:243-245,922-942`; `docs/superpowers/plans/2026-07-14-dispatch-reliability.md:335-343` | The implemented cap is global (default 4), not provider-specific. |
| Interleave tasks without multiple in-flight provider requests (`todo-07-15.txt:13-14`) | no | `src/tasks.js:922-1056`; `docs/superpowers/plans/2026-07-14-dispatch-reliability.md:335-343` | No scheduler interleaves logical tasks through one provider request; the global cap is adjacent work. |
| Prefer `status` over `wait`/poll when it suffices (`todo-07-15.txt:17`) | no | `skills/taskferry/SKILL.md:32-38`; `src/output.js:87-90` | Current guidance presents both together; no plan states this decision rule. |
| Encourage callers to use `next` fields (`todo-07-15.txt:18`) | partial | `docs/superpowers/plans/2026-07-14-taskferry-advisor.md:11-15`; `src/output.js:87-105`; `skills/taskferry/SKILL.md:32-50` | `next` hints are implemented and the advisor plan requires them. The worker skill never tells callers to actually consume `next`, so the prompting request stays open. |
| Sanitized `failureReason`/`failureDetail` parsing (`todo-07-15.txt:21`) | partial | `docs/superpowers/plans/2026-07-14-dispatch-reliability.md:468-476,673-683`; `src/tasks.js:139-170` | `failureReason` is set for timeout/exhaustion. `failureDetail` and a sanitized terminal-error parser are undefined anywhere. |
| Return both fields from wait/`status --full`/`result --full` (`todo-07-15.txt:22`) | partial | `docs/superpowers/plans/2026-07-14-dispatch-reliability.md:531-552`; `src/tasks.js:560-570,1650-1668`; `src/output.js:57-90` | `failureReason` is present in full status/wait/result. `failureDetail` is absent everywhere; lean projections omit `failureReason` unless `--full`. |
| Classify `authentication_failed`, `payment_required`, `rate_limited`, `no_output_timeout` (`todo-07-15.txt:23`) | partial | `docs/superpowers/plans/2026-07-14-dispatch-reliability.md:673-683`; `src/tasks.js:139-170,1195-1215` | Only `no_output_timeout` of the four exists as named. Rate-limit text collapses into `provider_usage_exhausted`; auth/payment buckets don't exist. |
| Redact credentials/headers/bodies from provider diagnostics (`todo-07-15.txt:24`) | no | `src/tasks.js:974-987`; `docs/security.md:18-26` | OpenCode stdout/stderr is written verbatim; security docs explicitly say no redaction occurs. |
| Report key-slot names, provider targets, daemon inheritance/source path in `doctor --full` (`todo-07-15.txt:25`; `todo-07-16.txt:77-80`) | no | `src/commands.js:123-125`; `src/daemon.js:170-175`; `docs/cli-reference.md:233-238` | Deduplicated — one item. Current `doctor --full` adds only CLI/protocol versions; a stale-worktree daemon stays invisible. |
| Reject unknown/unavailable key slots before spawning (`todo-07-15.txt:26`) | **yes** | `docs/superpowers/plans/2026-07-14-dispatch-reliability.md:796-805,906-960`; `src/tasks.js:620-633,647-660` | Already implemented (reliability Task 7) and preserved by AXI CLI dispatch. Only fully-covered item, and the only one already done. |
| `wait --timeout-ms N` should actually wait (`todo-07-16.txt:4-19`) | no | `src/tasks.js:128,1316-1349`; `docs/superpowers/plans/2026-07-14-taskferry-advisor.md:16-19,151-157`; `continuation-watchdog-escalation.md:83-90` | Blocking itself works. The real defect: `MAX_WAIT_MS = 45000` silently clamps any larger `--timeout-ms`. The advisor plan explicitly preserves this cap — see readiness note below, this is now being revised. |
| No-output watchdog kills long final writing (`todo-07-16.txt:20-44`) | partial | `docs/superpowers/plans/2026-07-16-watchdog-output-escalation.md:5-20,197-206`; `src/tasks.js:251-257,1160-1215,391-398` | The open plan's post-output budget (300s latch) covers the core case. It doesn't cover token/reasoning-activity resets or a per-dispatch flag. Task 2's daemon re-adoption test premise is invalid (see Plan Status). Nothing from this plan is implemented yet. |
| Clean exit with empty/truncated final message (`todo-07-16.txt:46-60`) | no | `src/tasks.js:1017-1026,1590-1646`; `docs/superpowers/plans/2026-07-16-watchdog-output-escalation.md:20` | Exit code 0 → `done` even when `message` is empty. No final-marker validation exists; the watchdog plan explicitly excludes this issue. |
| PATH wrapper breaks after checkout rename (`todo-07-16.txt:62-70`) | no | `docs/superpowers/plans/2026-07-16-taskferry-setup.md:15-19,111-132`; `src/cli.js:78-83` | The setup plan's premise (install a symlink) is invalid: `src/cli.js`'s `argv[1] === import.meta.url` guard makes a symlink invocation skip `main()` silently (exit 0, no output) — reproduced empirically with a temporary symlink. Plan needs a wrapper-script redesign, not just implementation. |
| Truncate default `result` message with a pointer (`todo-07-16.txt:74-76`) | no | `src/output.js:93-105`; `src/tasks.js:1642-1667` | Narration is already truncated by default; `message` is not. No plan adds this. |
| Suggest a prefilled resume command after `no_output_timeout` (`todo-07-16.txt:81-84`) | no | `src/tasks.js:1142-1157,1650-1667`; `skills/taskferry/SKILL.md:15-22` | Session resume works generally, but no `next` hint builds the resume command from the crashed task's session id. |

## Plan Status

| Plan | Done / merged | Genuinely open, partial, or stale |
|---|---|---|
| `2026-07-14-dispatch-reliability.md` | Tasks 1–8 (decode import, file locking, merged persistence, concurrency cap, watchdog, provider classifier, dispatch key-slot rejection, summary key-slot rejection) are in `src/cancel-smoke-test.js`, `src/state-lock.js`, `src/tasks.js`. Task 9's MCP docs migrated into AXI docs after `src/server.js` was removed. | Task 10 (live exhausted-key/key-slot run) has no recorded result. Classifier still exposes only `provider_usage_exhausted`/`no_output_timeout`. **Ready to close out** — no new design needed, just run and record. |
| `2026-07-14-taskferry-advisor.md` | Tasks 1–4 fully implemented/migrated: `poll`, advisor TTL/composition, daemon RPC, CLI surface (`src/tasks.js:602-614,1316-1405`; `src/daemon.js:181-208`). | None. `src/server.js`/MCP references are historical, superseded by AXI. **Done.** |
| `2026-07-15-taskferry-axi-cli.md` | Tasks 1–11 present: events, daemon, CLI, activity, integrations, skills, smoke tests, docs (`src/args.js:15-130`; `src/daemon.js:170-215`; `src/commands.js:33-129`). | Task 12 is verification-only, should rerun after open plans settle. Plan explicitly excludes `taskferry setup`. **Ready to close out.** |
| `2026-07-15-taskferry-brand-prototype.md` | Concept board fully built on `feat/taskferry-brand`. | Not on `main`; no `brand-assets/` file here. Tasks 1–3 open on `main`. **This is a merge decision, not implementation work.** |
| `2026-07-16-taskferry-setup.md` | Design documentation only. | Tasks 1–3 open. **Not ready as written** — Task 1's symlink installation conflicts with `src/cli.js:78-83`'s entrypoint guard; empirically reproduces a silent exit-0. Needs a wrapper-script redesign before any task executes correctly. |
| `2026-07-16-watchdog-output-escalation.md` | The earlier single-budget watchdog (from the reliability plan) exists at `src/tasks.js:1160-1215`. | Tasks 1–3 open. **Partially ready** — Tasks 1 and 3 (post-output budget/latch, docs) look implementable as written. Task 2's re-adoption test is invalid: `loadPersisted()` relabels active tasks `unknown` on restart and `startRunningWatcher()` only starts on new dispatch, so the scenario it tests can't occur as described. Needs rewriting before implementation. |

## Deduplication

- `todo-07-15.txt:25` and `todo-07-16.txt:77-80` are one doctor-diagnostics item.
- `todo-07-15.txt:23`'s `no_output_timeout` bucket is the same classification as the existing reliability work; `todo-07-16.txt:20-44` is a distinct post-first-output timeout-budget problem.
- `todo-07-15.txt:2-4` (poll response shape) and `todo-07-16.txt:4-19` (wait duration/clamping) are separate defects, not a duplicate.
- `todo-07-15.txt:26` is the only fully covered item and is already implemented.

## Corroborating Verification (from the independent review pass)

Run against `main` on 2026-07-16 23:54, before either audit document existed:

- `npm test`: 190 passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `git diff --check`: only pre-existing trailing whitespace in uncommitted `todo-07-15.txt` additions.

## Readiness Assessment

**Not ready to implement across the board.** Breakdown:

- **Already done, nothing to implement:** `taskferry-advisor` (full), `taskferry-axi-cli` (full except a verification rerun), `dispatch-reliability` (8 of 10 tasks; Task 10 is a live-run-and-record verification task, not new code).
- **Done but not merged:** `taskferry-brand-prototype` — a branch/merge decision, not engineering work.
- **Blocked on a premise fix before implementation, not just "start coding":**
  - `taskferry-setup` — Task 1's symlink mechanism is provably wrong against current `src/cli.js`; needs a redesigned installation approach first.
  - `watchdog-output-escalation` — Task 2's re-adoption test scenario can't happen given how `loadPersisted()`/`startRunningWatcher()` actually work; needs a corrected task before implementation.
- **No plan exists at all** for roughly 15 of the ~26 todo items across both files — the queueing/UX backlog (tool/agent selection, polling interval, one-in-flight providers, interleaving), the admin UI, prompting-rule changes, diagnostics redaction, `doctor --full` environment reporting, `failureDetail`, four-bucket failure classification, and — per the new requests below — the wait-clamp removal and the LLM progress-summary feature. These need plans written before they're implementable.

So: two plans are ready to close out with no new design, two plans need their broken task rewritten first, and the majority of the actual backlog has no plan yet.
