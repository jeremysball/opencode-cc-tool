import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./state-lock.js";

function tmpLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-lock-test-"));
  return path.join(dir, "state.lock");
}

describe("withFileLock()", () => {
  test("runs fn and removes the lock file afterward", () => {
    const lockPath = tmpLockPath();
    const result = withFileLock(lockPath, () => 42);
    assert.equal(result, 42);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("removes the lock file even if fn throws, and rethrows", () => {
    const lockPath = tmpLockPath();
    assert.throws(() => withFileLock(lockPath, () => { throw new Error("boom"); }), /boom/);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("reclaims a stale lock file and proceeds", () => {
    const lockPath = tmpLockPath();
    fs.writeFileSync(lockPath, "");
    const oldMs = Date.now() / 1000 - 3600;
    fs.utimesSync(lockPath, oldMs, oldMs);
    const result = withFileLock(lockPath, () => "ran", { staleMs: 100, retryMs: 10, timeoutMs: 500 });
    assert.equal(result, "ran");
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("throws a structured timeout error when a fresh lock file is never released", () => {
    const lockPath = tmpLockPath();
    fs.writeFileSync(lockPath, "");
    assert.throws(
      () => withFileLock(lockPath, () => "unreachable", { staleMs: 60000, retryMs: 10, timeoutMs: 60 }),
      /error: timed out waiting for lock/
    );
    fs.unlinkSync(lockPath); // test-owned cleanup; withFileLock never acquired it
  });

  test("does not remove a lock file that was replaced by another owner", () => {
    const lockPath = tmpLockPath();

    withFileLock(lockPath, () => {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, "replacement-owner", { mode: 0o600 });
    });

    assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement-owner");
    fs.unlinkSync(lockPath);
  });
});
