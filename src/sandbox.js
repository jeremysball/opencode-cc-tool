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
 * @param {string} homeDir
 * @param {string} stateDir
 * @returns {string[]}
 */
function defaultDenyList(homeDir, stateDir) {
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
 * @returns {string[]}
 */
export function buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList = defaultDenyList(homeDir, stateDir) }) {
  const args = ["--ro-bind", "/", "/"];
  for (const denied of denyList) {
    args.push("--tmpfs", denied);
  }
  args.push("--bind", directory, directory);
  args.push("--bind", runtimeDir, runtimeDir);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--unshare-all", "--share-net", "--die-with-parent");
  return args;
}