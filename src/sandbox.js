import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function platformSupportsSandbox(platform = process.platform) {
  return platform === "linux";
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {{status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}}
 */
export function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  if (result.error) {
    return { status: null, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
  }
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

/**
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [runCommand]
 * @returns {{checked: boolean, available: boolean, reason?: string}}
 */
export function checkBwrapAvailable(runCommand = defaultRunCommand) {
  const result = runCommand("bwrap", ["--version"]);
  if (result.error) {
    return {
      checked: true,
      available: false,
      reason: result.error.code === "ENOENT" ? "bwrap not found" : `bwrap --version failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return { checked: true, available: false, reason: `bwrap --version exited with status ${result.status}` };
  }
  return { checked: true, available: true };
}

/**
 * The fixed v1 deny-list. Callers building a real bwrap invocation must
 * filter out entries that don't exist on disk before passing this to
 * buildBwrapArgs() — bwrap's --tmpfs fails if the mount point doesn't
 * already exist under the read-only-bound root.
 * @param {string} homeDir
 * @param {string} stateDir
 * @returns {string[]}
 */
export function defaultDenyList(homeDir, stateDir) {
  return [
    stateDir,
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".config", "gcloud"),
    path.join(homeDir, ".config", "gh"),
    path.join(homeDir, ".gnupg"),
  ];
}

/**
 * @param {object} options
 * @param {string} options.directory
 * @param {string} options.stateDir
 * @param {string} options.runtimeDir
 * @param {string} options.homeDir
 * @param {string[]} [options.denyList]
 * @param {[string, string][]} [options.extraRoBinds] - extra [src, dest] read-only binds, applied after the
 *   read-write binds so a more specific path (e.g. a single credentials file) can be pinned read-only even
 *   though it sits under an already read-write-bound directory.
 * @returns {string[]}
 */
export function buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList = defaultDenyList(homeDir, stateDir), extraRoBinds = [] }) {
  const args = ["--ro-bind", "/", "/"];
  // bwrap applies mounts in argument order, and a later mount on a parent
  // directory shadows an earlier mount nested inside it. --tmpfs /tmp must
  // come before the deny-list and read-write binds below, or any of them
  // that happen to live under /tmp (a plausible scratch/CI/worktree path)
  // would silently disappear behind the fresh, empty /tmp tmpfs.
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const denied of denyList) {
    args.push("--tmpfs", denied);
  }
  args.push("--bind", directory, directory);
  args.push("--bind", runtimeDir, runtimeDir);
  for (const [src, dest] of extraRoBinds) {
    args.push("--ro-bind", src, dest);
  }
  args.push("--unshare-all", "--share-net", "--die-with-parent");
  return args;
}