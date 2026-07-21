# Taskferry — Efficiency red-team pass (2026-07-19)

Repo: /workspace/taskferry (branch: main)
Mode: Efficiency (UX focus mode from automating-repo-review), single mode per user request
Model: opencode/deepseek-v4-flash-free (Zen, max effort variant where supported)

## Dispatch plan

| ID | Scope | Prompt framing (perturbed) | Ferried input |
|----|-------|------------------------------|----------------|
| D1 | whole repo | "new contributor's first hour" framing | none |
| D2 | whole repo | "on-call engineer under time pressure" framing | none |
| D3 | src/tasks.js only | narrow hot-path scope | none |
| D4 | src/commands.js only | narrow hot-path scope | none |
| D5 | synthesis | cross-check/dedupe pass | raw output of D1-D4 |

**Model note:** `opencode/deepseek-v4-flash-free` (Zen) was down at dispatch
time — all 4 initial dispatches plus a PONG health-check crashed with
`no_output_timeout` / 0 log bytes within seconds. A PONG health-check on
`opencode/nemotron-3-ultra-free` succeeded immediately, confirming this
was an endpoint-specific outage, not systemic. Redispatched all 4 on
`opencode/nemotron-3-ultra-free` (next-ranked Zen free model, same "real
work" tier per picking-a-free-model) instead.

Task IDs (attempt 1, deepseek-v4-flash-free — all crashed, no_output_timeout):
- D1: oc_mrrfhwu3_fbd9659d (crashed)
- D2: oc_mrrfhzwr_354d18f4 (crashed)
- D3: oc_mrrfi1y9_65274c13 (crashed)
- D4: oc_mrrfi4k5_edb987b3 (crashed)

Task IDs (attempt 2, nemotron-3-ultra-free):
- D1 (whole repo, new-contributor framing): oc_mrrfrim1_3776cec3
- D2 (whole repo, on-call framing): oc_mrrfrkom_a873bc82
- D3 (src/tasks.js only): oc_mrrfrmoi_6111c67d
- D4 (src/commands.js only): oc_mrrfrovm_e386bae8
- D5 (synthesis, ferried D1-D4): oc_mrrfvgxd_2cdff4ae

## Findings

D5 produced a 30-item deduplicated/ranked synthesis from D1-D4. Each item was
independently re-verified against current `/workspace/taskferry` source
(not trusted from D5's self-report) and cross-checked against the 19
pre-existing open issues (#30-40, #45-54) before filing. Verification and
dedup notes below; issue numbers recorded immediately after each `gh-axi
issue create` call.

### Duplicate of an existing open issue (not filed)

- **D5 #12** ("Four separate log-parsing functions duplicate JSON-line
  parsing logic") — same underlying issue as already-open **#45**
  ("Consolidate 5-way narration-indexing duplication in
  activity.js/tasks.js"), which lists the same 5 functions (including
  `narrationFromRaw` in activity.js that D5 also names). Linked, not filed.
- **D5 #15** (`poll()` timeout path full-parses log via `readNarration` just
  to tail) — `readNarration` is one of the 5 duplicated functions from #45;
  folded into a comment on #45 rather than filed separately.

### Dropped as not a real inefficiency (verification found the claim wrong)

- **D5 #21** ("`summary --wait` does two sequential daemon round-trips that
  could be parallelized") — verified `src/commands.js:129-141`: `task.summary`
  is only requested once `task.wait` has confirmed the task settled; the two
  calls are a real dependency, not independent work. Not filed.
- **D5 #13's "double statSync per running task"** framing overstated: watcher
  reads only bytes appended since the last tick (`src/tasks.js:1453-1462`
  comment + `bytesRead` tracking), not the whole file each tick. The double
  **JSON.parse pass on the new bytes** (`classifyProviderFailure` then
  `.some(...)` at `tasks.js:1501,1507`) is real and is what got filed.

### Confirmed and filed

1. **`persistTask()` rewrites all of `tasks.json` on every single task state
   transition** (`src/tasks.js:623-659`, 8+ call sites) — O(n×m) I/O.
   Verified directly against source. → **issue #55**
2. **`logActivity()` does synchronous blocking file I/O on every `status()`
   poll** (`src/tasks.js:1580-1613`, called at `1625`) — `statSync` +
   `openSync`/`readSync`/`closeSync` + line-by-line `JSON.parse` on every
   poll. Bounded to 64KB and breaks on first parseable line (tempered from
   D5's framing, which implied unbounded cost), but still sync I/O on a
   polled hot path. → **issue #56**
3. **`startRunningWatcher()` double-parses newly appended log bytes every
   watchdog tick** (`src/tasks.js:1501,1507`) — `classifyProviderFailure`
   and the `.some(...)` activity check each independently `JSON.parse` the
   same new lines. → **issue #57**
4. **`result()` always fully reads+parses the entire log even when a narrow
   `fields` filter is requested, and does so redundantly alongside
   `extractFinalMessage()` on the same completion event** (`src/tasks.js:
   1960-2005` reads unconditionally before `projectResult` applies the
   filter; `extractFinalMessage` at `1911-1953` does a second independent
   full parse). Related to #45 (same 5-function family) but this finding is
   about runtime redundancy, not code duplication — noted as a comment on
   #45 rather than filed as a duplicate. → **issue #58**
5. **`commands.js` does an extra `task.status` round-trip solely to obtain
   `directory`**, in both `watch --task-id` (`src/commands.js:247-248`) and
   `wait --summarize` (`src/commands.js:82`, `initial` used only for
   `initial.directory`). → **issue #59**
6. **`doctor` blocks on a synchronous `claude plugin list` subprocess
   (`spawnSync`-based `defaultShellRunner`) sequentially after already
   awaiting the `system.health` daemon RPC** (`src/commands.js:165-167`) —
   two independent operations, no shared state, should run concurrently.
   → **issue #60**
7. **`wait` has no default timeout and can block forever**
   (`src/tasks.js:139-141` comment explicitly admits this; `poll()` at
   `1633-1663` only arms a timer if `timeoutMs` is passed) — unlike
   `advisor()`, which gets a 45s `MAX_WAIT_MS` safety net. → **issue #61**
8. **No composed dispatch+wait convenience** — `dispatch` has no `--wait`
   flag (`src/args.js:398` command spec has no such option) and there is no
   `taskferry run` command; the canonical workflow is dispatch → copy task
   ID → wait → result (3 commands, manual copy-paste each time,
   `src/commands.js:59-71,77-99,145-151`). → **issue #62**

Dropped from filing as roadmap/feature-request territory rather than red-team
bugs: D5 items #1,4-8,22-30 (missing `--format json` on more commands, no
per-workspace config defaults, no `resume`/`--continue`, no `--latest`, etc.)
substantially overlap with this repo's existing "Tier Open Notes: Small
Unplanned Items" roadmap issues (#31-38), which already track this class of
CLI-ergonomics work. Folded the single highest-value item from that group
(the missing `--wait`/`run` composition) into issue #62 above rather than
filing the whole pile as 15 more issues.
