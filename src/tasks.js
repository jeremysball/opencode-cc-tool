import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_STATE_DIR =
  process.env.OPENCODE_CC_TOOL_STATE_DIR ||
  path.join(os.homedir(), ".opencode-cc-tool");

// The MCP tool-call default timeout in Claude Code is 60s (MCP_TOOL_TIMEOUT).
// Cap the internal wait below that so a long task returns a clean
// "still running" instead of the whole tool call erroring out from the
// client side with no result at all.
const MAX_WAIT_MS = 45000;

const NARRATION_PREVIEW_CHARS = 2000;

// Factory rather than a module-level singleton, so tests can construct an
// isolated instance with an injected spawnFn/killFn (no real `opencode`
// process, no real OS signals) and its own state directory, instead of
// sharing process-wide state with every other test or the real server.
// `defaultTaskManager` below is the one real instance server.js uses.
export function createTaskManager({
  spawnFn = spawn,
  killFn = (pid, signal) => process.kill(pid, signal),
  stateDir = DEFAULT_STATE_DIR,
} = {}) {
  const LOG_DIR = path.join(stateDir, "logs");
  const TASKS_FILE = path.join(stateDir, "tasks.json");
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // In-memory map is the source of truth for "running" while this server
  // process is alive: process exit is delivered via the 'exit' event on our
  // own child_process handle, which only exists in the process that spawned
  // it. tasks.json is a best-effort record for opencode_list/debugging across
  // a server restart, not a re-attach mechanism. A restarted server has no
  // handle to a child spawned by its previous instance, so any task still
  // "running" in the file when we reload it is relabeled "unknown" rather
  // than reported as a stale, possibly-wrong "running".
  const tasks = new Map();

  // Escalation timers for opencode_cancel, keyed by task id. Kept out of the
  // task object itself: task objects get JSON.stringify'd wholesale in
  // persist(), and a Timeout isn't serializable data.
  const escalationTimers = new Map();

  // Pending opencode_wait callbacks, keyed by task id. Lets a single MCP tool
  // call block until the child's exit event fires (or a timeout elapses)
  // instead of the caller round-tripping opencode_status in a loop. Not
  // persisted or shared across a server restart, same as the tasks map itself.
  const waiters = new Map();

  function loadPersisted() {
    try {
      const raw = fs.readFileSync(TASKS_FILE, "utf8");
      const persisted = JSON.parse(raw);
      for (const t of persisted) {
        if (t.status === "running") t.status = "unknown";
        tasks.set(t.id, t);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  loadPersisted();

  function persist() {
    const all = Array.from(tasks.values());
    fs.writeFileSync(TASKS_FILE, JSON.stringify(all, null, 2));
  }

  function summarize(task) {
    const { promptPreview, promptTotalChars, id, status, directory, model, sessionId, pid, startedAt, endedAt, exitCode, signal, logPath, cancelRequested } = task;
    return {
      id, status, directory, model, sessionId, pid, startedAt, endedAt, exitCode, signal, logPath,
      promptPreview,
      ...(promptTotalChars != null ? { promptTotalChars } : {}),
      cancelRequested: !!cancelRequested,
    };
  }

  // Minimal per-row schema for opencode_list: an agent scanning a task list
  // needs id/status/model/startedAt to decide what to poll next, not the full
  // detail (directory, pid, logPath, ...) that summarize() carries for a
  // single-task lookup.
  function summarizeRow(task) {
    const { id, status, model, startedAt } = task;
    return { id, status, model, startedAt };
  }

  function noSuchTask(taskId) {
    return new Error(`error: unknown task_id: ${taskId}\nhelp: run opencode_list to see valid task ids`);
  }

  function dispatch({ prompt, directory, model, variant, sessionId }) {
    if (!prompt || typeof prompt !== "string") {
      throw new Error("error: prompt is required\nhelp: opencode_dispatch requires a non-empty prompt string");
    }
    if (!directory || !path.isAbsolute(directory)) {
      throw new Error(`error: directory must be an absolute path (got ${JSON.stringify(directory)})\nhelp: pass the full path, e.g. "/workspace/my-repo"`);
    }
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error(`error: directory does not exist: ${directory}\nhelp: check the path or create the directory first`);
    }

    const id = `oc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const logPath = path.join(LOG_DIR, `${id}.ndjson`);
    const logFd = fs.openSync(logPath, "a");

    const usingDefaultModel = !model;
    const resolvedModel = model || "openai/gpt-5.6-luna";

    const args = ["run", "--dir", directory, "--auto", "--format", "json"];
    args.push("-m", resolvedModel);
    if (usingDefaultModel) {
      args.push("--variant", "high");
    } else if (variant) {
      args.push("--variant", variant);
    }
    if (sessionId) {
      args.push("--continue", "--session", sessionId);
    }
    args.push("--", prompt);

    // No tmux: the child is spawned directly with its stdio redirected to a
    // private log file it cannot introspect. It has no session/pane to list,
    // so it can't mistake the orchestration layer for a sibling task the way
    // a tmux-wrapped run could (the bug this tool exists to avoid).
    //
    // detached: true makes the child its own process group leader (pgid ===
    // pid), not a fully-detached background daemon -- we still hold a direct
    // reference and listen on its 'exit' event the same as before. The reason
    // is opencode_cancel: opencode can itself spawn a subprocess (e.g. a bash
    // command it's running). Signaling just task.pid stops opencode but can
    // leave that subprocess orphaned and running. Signaling the negative pid
    // targets the whole process group in one call. Without detached: true,
    // the child would share this server's own process group, and a group
    // kill would take the server down with it.
    const child = spawnFn("opencode", args, {
      cwd: directory,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    fs.closeSync(logFd);

    const task = {
      id,
      status: "running",
      directory,
      model: resolvedModel,
      variant: usingDefaultModel ? "high" : variant || null,
      sessionId: sessionId || null,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
      logPath,
      promptPreview: prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt,
      promptTotalChars: prompt.length > 200 ? prompt.length : null,
      spawnError: null,
      cancelRequested: false,
    };
    tasks.set(id, task);
    persist();

    child.on("exit", (code, signal) => {
      const timer = escalationTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        escalationTimers.delete(id);
      }
      task.status = task.cancelRequested ? "cancelled" : code === 0 && !signal ? "done" : "crashed";
      task.exitCode = code;
      task.signal = signal;
      task.endedAt = new Date().toISOString();
      const parsedSessionId = readSessionIdFromLog(logPath);
      if (parsedSessionId) task.sessionId = parsedSessionId;
      persist();
      settleWaiters(id);
    });

    child.on("error", (err) => {
      task.status = "crashed";
      task.spawnError = String(err && err.message ? err.message : err);
      task.endedAt = new Date().toISOString();
      persist();
      settleWaiters(id);
    });

    child.unref();

    return { ...summarize(task), next: `Run opencode_wait or opencode_status with task_id "${id}" to check progress` };
  }

  function cancel(taskId, { graceMs = 5000 } = {}) {
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (task.status !== "running") {
      return { ...summarize(task), note: `task is already ${task.status}; nothing to cancel` };
    }
    if (task.pid == null) {
      throw new Error(`error: task ${taskId} has no pid on record; cannot signal it\nhelp: run opencode_status to inspect its recorded state`);
    }

    task.cancelRequested = true;
    persist();
    sendSignal(task.pid, "SIGTERM");

    const timer = setTimeout(() => {
      escalationTimers.delete(taskId);
      if (tasks.get(taskId)?.status === "running") {
        sendSignal(task.pid, "SIGKILL");
      }
    }, graceMs);
    escalationTimers.set(taskId, timer);

    return { ...summarize(task), note: `SIGTERM sent to process group ${task.pid}; escalates to SIGKILL after ${graceMs}ms if it hasn't exited` };
  }

  // Targets the process group (negative pid), which reaches opencode and any
  // subprocess it spawned (e.g. a bash command it's mid-way through running),
  // since dispatch() makes the child a process group leader for exactly this.
  // Falls back to the plain pid if group signaling isn't available (ESRCH on
  // -pid can mean the group is already gone even though a stray pid isn't,
  // though in practice these move together since detached: true makes them
  // the same process).
  function sendSignal(pid, signal) {
    try {
      killFn(-pid, signal);
      return;
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
    try {
      killFn(pid, signal);
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
  }

  function status(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    return summarize(task);
  }

  function wait(taskId, { timeoutMs = MAX_WAIT_MS } = {}) {
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    const cappedMs = Math.min(timeoutMs, MAX_WAIT_MS);
    if (task.status !== "running") {
      return Promise.resolve(summarize(task));
    }
    return new Promise((resolve) => {
      const settle = () => {
        const list = waiters.get(taskId);
        if (list) {
          const idx = list.indexOf(settle);
          if (idx !== -1) list.splice(idx, 1);
        }
        clearTimeout(timer);
        resolve(summarize(tasks.get(taskId)));
      };
      const timer = setTimeout(settle, cappedMs);
      if (!waiters.has(taskId)) waiters.set(taskId, []);
      waiters.get(taskId).push(settle);
    });
  }

  function settleWaiters(taskId) {
    const list = waiters.get(taskId);
    if (!list) return;
    waiters.delete(taskId);
    for (const settle of list.slice()) settle();
  }

  function list() {
    const all = Array.from(tasks.values()).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const counts = { running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 };
    for (const t of all) {
      if (counts[t.status] != null) counts[t.status]++;
    }
    return {
      counts,
      tasks: all.length ? all.map(summarizeRow) : "none found (this server process's lifetime)",
    };
  }

  function readSessionIdFromLog(logPath) {
    try {
      const lines = fs.readFileSync(logPath, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.sessionID) return evt.sessionID;
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  function result(taskId, { full = false } = {}) {
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (task.status === "running") {
      return { taskId, status: "running", message: "task is still running; poll opencode_status first" };
    }

    // opencode's own steps look like: text (narration) -> tool_use -> step_finish
    // (reason "tool-calls") -> text -> step_finish (reason "stop"), one messageID
    // per step. Naively joining every text event across every step glues
    // "I'm about to run ls" onto the actual answer with no separator -- neither
    // a clean final answer nor a real transcript. Only the messageID whose step
    // ended in reason "stop" is the model's actual final turn; everything
    // earlier is intermediate narration, kept separately as `narration` so
    // nothing is silently dropped, but not returned as `message`.
    let sessionId = task.sessionId;
    let tokens = null;
    let cost = null;
    const textByMessageId = new Map();
    const textOrder = [];
    let finalMessageId = null;

    let raw = "";
    try {
      raw = fs.readFileSync(task.logPath, "utf8");
    } catch {
      raw = "";
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // non-JSON line (e.g. a crash stack trace on stderr, interleaved into the same fd)
      }
      if (evt.sessionID) sessionId = evt.sessionID;
      if (evt.type === "text" && evt.part && typeof evt.part.text === "string") {
        const mid = evt.part.messageID;
        if (!textByMessageId.has(mid)) {
          textByMessageId.set(mid, []);
          textOrder.push(mid);
        }
        textByMessageId.get(mid).push(evt.part.text);
      }
      if (evt.type === "step_finish" && evt.part) {
        if (evt.part.tokens) tokens = evt.part.tokens;
        if (typeof evt.part.cost === "number") cost = evt.part.cost;
        if (evt.part.reason === "stop") finalMessageId = evt.part.messageID;
      }
    }

    // Fall back to the last messageID seen if no explicit "stop" step_finish
    // was found (e.g. a crashed run that never reached one).
    const targetId = finalMessageId ?? textOrder[textOrder.length - 1];
    const message = targetId && textByMessageId.has(targetId) ? textByMessageId.get(targetId).join("") : "";
    const fullNarration = textOrder.map((mid) => textByMessageId.get(mid).join("")).join("\n\n");
    const truncated = !full && fullNarration.length > NARRATION_PREVIEW_CHARS;
    const narration = truncated ? fullNarration.slice(0, NARRATION_PREVIEW_CHARS) + "…" : fullNarration;

    return {
      taskId,
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      spawnError: task.spawnError,
      sessionId,
      tokens,
      cost,
      message,
      narration,
      narrationTotalChars: fullNarration.length,
      narrationTruncated: truncated,
      ...(truncated ? { next: `Run opencode_result with full: true on task_id "${taskId}" to see the complete narration` } : {}),
      logPath: task.logPath,
    };
  }

  return { dispatch, cancel, status, wait, list, result, paths: { STATE_DIR: stateDir, LOG_DIR, TASKS_FILE } };
}

// The one real instance the MCP server uses: real spawn, real process.kill,
// real state directory. Everything else (tests) calls createTaskManager()
// directly with injected spawnFn/killFn and an isolated stateDir.
export const defaultTaskManager = createTaskManager();
