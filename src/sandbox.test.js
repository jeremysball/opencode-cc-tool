import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildBwrapArgs, checkBwrapAvailable, platformSupportsSandbox } from "./sandbox.js";

describe("platformSupportsSandbox()", () => {
  test("is true on linux", () => {
    assert.equal(platformSupportsSandbox("linux"), true);
  });

  test("is false on darwin", () => {
    assert.equal(platformSupportsSandbox("darwin"), false);
  });

  test("is false on win32", () => {
    assert.equal(platformSupportsSandbox("win32"), false);
  });

  test("defaults to process.platform when no argument is given", () => {
    assert.equal(platformSupportsSandbox(), process.platform === "linux");
  });
});

describe("checkBwrapAvailable()", () => {
  test("reports available when the probe exits 0", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "bwrap");
      assert.deepEqual(args, ["--version"]);
      return { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined };
    };
    assert.deepEqual(checkBwrapAvailable(runCommand), { checked: true, available: true });
  });

  test("reports unavailable with an ENOENT-derived reason when the binary is missing", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.checked, true);
    assert.equal(result.available, false);
    assert.match(result.reason, /bwrap not found/);
  });

  test("reports unavailable with the spawn error message for a non-ENOENT error", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: "EACCES", message: "spawnSync bwrap EACCES" } });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.available, false);
    assert.match(result.reason, /EACCES/);
  });

  test("reports unavailable when the probe exits non-zero with no spawn error", () => {
    const runCommand = () => ({ status: 1, stdout: "", stderr: "boom", error: undefined });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.available, false);
    assert.match(result.reason, /status 1/);
  });
});

describe("buildBwrapArgs()", () => {
  test("orders ro-bind, then deny-list tmpfs, then read-write binds, then standard flags", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
    });

    assert.deepEqual(args.slice(0, 3), ["--ro-bind", "/", "/"]);
    assert.equal(args[3], "--tmpfs");

    const deniedPaths = [
      "/home/user/.local/state/taskferry",
      path.join("/home/user", ".ssh"),
      path.join("/home/user", ".aws"),
      path.join("/home/user", ".config", "gcloud"),
      path.join("/home/user", ".config", "gh"),
      path.join("/home/user", ".gnupg"),
    ];
    for (const denied of deniedPaths) {
      const index = args.indexOf(denied);
      assert.notEqual(index, -1, `expected ${denied} to be tmpfs-denied`);
      assert.equal(args[index - 1], "--tmpfs");
    }

    // The state dir's tmpfs deny must come before the runtime dir's read-write
    // bind, since runtimeDir is nested under stateDir in the default layout
    // and bwrap applies rules in argument order.
    const stateDirTmpfsIndex = args.indexOf("/home/user/.local/state/taskferry");
    const runtimeDirBindIndex = args.lastIndexOf("/home/user/.local/state/taskferry/run");
    assert.ok(stateDirTmpfsIndex < runtimeDirBindIndex);
    assert.equal(args[runtimeDirBindIndex - 1], "/home/user/.local/state/taskferry/run");
    assert.equal(args[runtimeDirBindIndex - 2], "--bind");

    const directoryBindIndex = args.lastIndexOf("/workspace/my-repo");
    assert.equal(args[directoryBindIndex - 1], "/workspace/my-repo");
    assert.equal(args[directoryBindIndex - 2], "--bind");

    assert.deepEqual(args.slice(-9), [
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--unshare-all", "--share-net", "--die-with-parent",
    ]);
  });

  test("accepts an injected denyList override", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: ["/only/this/path"],
    });
    assert.equal(args[3], "--tmpfs");
    assert.equal(args[4], "/only/this/path");
    assert.equal(args.indexOf("/home/user/.ssh"), -1);
  });
});
