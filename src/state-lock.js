import fs from "node:fs";

// A synchronous, cross-process exclusive lock backed by an exclusively-created
// file. Blocks the event loop via Atomics.wait while contended -- acceptable
// here because tasks.js's own state writes are already synchronous
// (fs.writeFileSync/renameSync) and only ever held for the duration of a
// single small JSON read-modify-write.
export function withFileLock(lockPath, fn, { staleMs = 10000, retryMs = 25, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let ageMs;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statErr) {
        if (statErr.code === "ENOENT") continue; // lock disappeared between attempts
        throw statErr;
      }
      if (ageMs >= staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          if (unlinkErr.code !== "ENOENT") throw unlinkErr;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`error: timed out waiting for lock: ${lockPath}\nhelp: another taskferry process may be stuck; remove the lock file if it is stale`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}
