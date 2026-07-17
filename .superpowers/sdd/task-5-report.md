# Task 5 report — Docs and final verification

Documentation-only wrap-up for the 5-task `watch --task-id` / `wait --summarize` plan.
No source code touched; only `docs/cli-reference.md`, `todo.txt`, and `docs/sourcemap.md`
(verified-only) are in scope per the brief.

## What changed

| File | Lines | Change |
|---|---|---|
| `docs/cli-reference.md` | 83 | Added `--summarize` row to the `wait` flag table |
| `docs/cli-reference.md` | 99-102 | Added the "live terminal, not scripts/agents" paragraph after the `wait` example block |
| `docs/cli-reference.md` | 225 | Added `--task-id` row to the `watch` flag table |
| `docs/cli-reference.md` | 227-229 | Added the "Without `--task-id`..." / "With it, `--directory` is optional..." sentence after the `watch` flag table |
| `todo.txt` | 70-79 | `LLM progress summaries (wait --summarize)`: `[_]` → `[X]`, replaced the `Status: unplanned` / `Plan: (none)` lines with a shipped-status line and a new `Details:` line describing what actually shipped |
| `docs/sourcemap.md` | — | No edit needed. The "Things that look like bugs but aren't" section makes no claim that `watch` always requires interrupt to exit, and no claim that `wait` never streams. The existing `wait`-blocking-forever entry is still accurate for plain `wait` (no flags); the new `--summarize` behaviour is opt-in and is documented in `cli-reference.md`, so the section does not need to add or modify anything. |

### `docs/cli-reference.md` diff (relevant excerpt)

```diff
@@ `wait` flag table @@
 | `--full` | Include directory, model, session id, log path, and prompt preview |
+| `--summarize` | Stream periodic live summaries to stdout while waiting; exits and returns the normal result the moment the task settles. Cannot combine with `--timeout-ms` or `--tail-chars`. |

@@ after the `wait` example block @@
 next: Run taskferry result with task id "oc_mrn4ipkp_19450105" to see the final message; pass --full here for directory/model/log path details
 ```
+
+`--summarize` is for a human watching a live terminal, not for scripts or
+agents: the periodic lines print as the wait progresses, and the final
+line is the same TOON block plain `wait` always returns, so anything
+parsing that final output sees no shape change.

@@ `watch` flag table @@
 | `--summaries` | Request live activity summaries (a secondary model call); see [security.md](security.md) |
+| `--task-id <id>` | Scope the stream to one task; `watch` then exits on its own once that task settles, instead of running until interrupted |

+Without `--task-id`, `watch` streams every task in the workspace until
+interrupted. With it, `--directory` is optional — it's resolved from the
+task itself when omitted.
+
 `ndjson` emits one JSON object per line, for scripting. ...
```

### `todo.txt` diff (relevant excerpt)

```diff
-[_] LLM progress summaries (wait --summarize)
-    Status: unplanned
-    Details: optional flag on wait/status to condense narration tail into a
-             one-line "what's happening now" via a small configurable model
-    Plan: (none) — needs design
+[X] LLM progress summaries (wait --summarize)
+    Status: shipped — on worktree-taskferry-summarizer (91b2469)
+    Details: `taskferry wait --summarize` streams periodic one-line
+             summaries of the running task's narration tail while waiting
+             (via the same activity-summary model `watch --summaries`
+             uses), and returns the same TOON status block plain `wait`
+             returns the moment the task settles. Mutually exclusive with
+             --timeout-ms and --tail-chars. Tests added in args.test.js
+             and commands.test.js. Docs in docs/cli-reference.md (wait
+             section).
```

## Verification commands and verbatim output

Commands run, in order, on the worktree at `ce13f2d` (this commit):

### 1. `npm test`

```
$ npm test
...
ℹ tests 203
ℹ suites 27
ℹ pass 197
ℹ fail 6
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6563.154146

✖ failing tests:

test at src/opencode-plugin.test.js:57:1
test at src/opencode-plugin.test.js:78:1
test at src/opencode-plugin.test.js:105:1
test at src/opencode-plugin.test.js:139:1
test at src/opencode-plugin.test.js:162:1
test at src/opencode-plugin.test.js:186:1
$ echo $?
1
```

**Exit 1, not 0.** All 6 failures are in `src/opencode-plugin.test.js` — the
pre-existing environmental failures the brief explicitly called out as not
blocking. Confirmed by:

1. The branch has not touched `src/opencode-plugin.test.js` in this plan
   (`git log --oneline -- src/opencode-plugin.test.js` on this branch shows
   only the prior `f1e5b99` and `19d7185` commits, neither from this plan).
2. Re-running the same `node --test src/opencode-plugin.test.js` after
   `git stash` of the docs/todo changes produces the same 6 failures, so
   they are independent of Task 5's edits.

The 6 tests that fail are the same 6 the brief warned about (subscriber
setup, dynamic toasts, terminal-task injection, transition consumption,
activity-text refresh, daemon-connection failure logging). Each fails
with either `0 !== 1` from a `subscribe` mock or `Cannot read properties
of undefined (reading 'onEvent')` / `transform is not a function` — i.e.
the test mocks don't match the runtime's plugin API shape in this
sandbox. Not in scope for this plan.

### 2. `npm run lint`

```
$ npm run lint
$ echo $?
0
```

Clean exit, no output, no warnings.

### 3. `npm run typecheck`

```
$ npm run typecheck
$ echo $?
0
```

Clean exit, no output.

### 4. `npm run skill:check`

```
$ npm run skill:check
$ echo $?
0
```

Clean exit, no output. Confirms the generated `integrations/*/skills/taskferry/SKILL.md`
copies are still in sync with `skills/taskferry/SKILL.md` after these
doc changes — this plan did not modify the canonical skill file.

## Deviations from the brief

1. **`docs/sourcemap.md` not edited.** The brief told me to verify no
   stale claims and only edit if I found one. I read the section
   (lines 99-108) and grep'd `docs/` for `watch.*interrupt`,
   `wait.*never`, `wait.*stream`, `watch.*stream` — the only mentions of
   "interrupt" or "stream" in the file are in the new flag-row prose I
   just added to `cli-reference.md` and in unrelated plan/spec files.
   The current sourcemap section makes no claim that `watch` always
   requires interrupt to exit (it doesn't claim anything about `watch` at
   all) and no claim that `wait` never streams (it describes plain `wait`
   blocking without flags, which is still true). The existing
   `taskferry wait blocking forever with no output` entry is still
   accurate: that describes plain `wait` without `--summarize`, which
   continues to block. No stale claim, no edit.

2. **`todo.txt` Details line rewritten rather than left in place.** The
   brief said "with a shipped status line, matching the style of other
   completed entries (see `Wait timeout clamp removal` for the exact
   format)." Looking at that reference entry, its `Details:` line
   describes what was actually shipped, not the original aspiration. The
   original aspiration here ("via a small configurable model") doesn't
   match what shipped: the implementation reuses the same
   activity-summary model `watch --summaries` uses, configured globally
   via `TASKFERRY_SUMMARY_MODEL` and friends, not via a per-call
   "configurable" parameter. I rewrote the `Details:` line to reflect
   the shipped behaviour, kept the title unchanged, and added the
   mutual-exclusivity note, the test pointer, and the doc pointer to
   match the reference entry's information density.

3. **Status reference uses the worktree branch, not "merged from ...".**
   The reference entries in `todo.txt` all read
   `shipped — merged from <branch> (<commit>)`. This plan is the wrap-up
   of the worktree itself, not a merge of a side branch into main yet,
   so I used `shipped — on worktree-taskferry-summarizer (91b2469)` —
   the current head of the worktree branch, which is the most recent
   commit that actually adds the `wait --summarize` flag. If/when this
   branch is merged into main, that line can be re-pointed to the merge
   commit in the same style as the other entries; I'm leaving the
   format consistent with the "live on this branch" reality rather than
   asserting a merge that hasn't happened in this session.

## Commit

```
$ git add docs/cli-reference.md todo.txt
$ git commit -m "docs: document watch --task-id and wait --summarize"
[worktree-taskferry-summarizer ce13f2d] docs: document watch --task-id and wait --summarize
 2 files changed, 21 insertions(+), 5 deletions(-)
```

`git status` after the commit shows only the unrelated
`.superpowers/sdd/task-4-report.md` modification (pre-existing from the
Task 4 wrap-up) as still unstaged — intentionally left out of this
commit per the brief's `git add` line.

## Concerns

- **The `npm test` step exits 1, not 0**, on this sandbox because of the
  6 pre-existing `src/opencode-plugin.test.js` failures the brief
  warned about. Verified independently that they reproduce with this
  task's docs/todo changes stashed, so they are not a Task 5
  regression. If a future CI run on a different host passes them, the
  0-failure count would be 203/203, exactly the same as the passing
  197/197 minus the 6 sandbox-only failures.
- No other concerns. `lint`, `typecheck`, and `skill:check` all pass
  clean with no output. The skill:check step passing confirms the
  `wait`/`watch` doc edits don't drift the generated skill files.
