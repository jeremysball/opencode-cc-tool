# Taskferry Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent Unix-only `taskferry setup` that installs the checkout, configures the CLI and OpenCode plugin, and registers available native clients.

**Architecture:** `src/setup.js` uses only Node built-ins to install dependencies, maintain two Taskferry-owned symlinks, and invoke native client CLIs. `src/cli.js` executes this path before dynamically loading modules that depend on `node_modules`, so `node src/cli.js setup` bootstraps a fresh clone.

**Tech Stack:** Node.js ESM, Node built-ins, npm, Node's built-in test runner.

## Global Constraints

- Reject `win32` because Taskferry requires Unix domain sockets.
- Run `npm install` in the checkout before creating symlinks.
- Manage only `~/.local/bin/taskferry` and `$XDG_CONFIG_HOME/opencode/plugins/taskferry.js`, defaulting `XDG_CONFIG_HOME` to `~/.config`.
- Refuse to replace a destination that is not a Taskferry source symlink.
- Install or update the Claude Code plugin when `claude` is available.
- Register or refresh the Codex marketplace when `codex` is available, then report that Codex desktop installation and hook trust remain required.
- Use `node src/cli.js setup` for a fresh clone and `taskferry setup` after `git pull`.
- Do not document global npm installation as an alternative.

---

### Task 1: Implement and Test the Setup Service

**Files:**
- Create: `src/setup.js`
- Create: `src/setup.test.js`

**Interfaces:**
- Produces: `runSetup({ checkoutDirectory, cliPath, homeDirectory, env, platform, runNpmInstall, runCommand })`.
- Produces: `{ cli, opencode, dependencies, path, pathInstruction?, integrations }`.
- `runCommand(command, args)` returns `{ status, stdout, stderr, error }`, where an unavailable executable returns `error.code === "ENOENT"`.

- [ ] **Step 1: Write failing setup tests**

Create a temporary checkout containing `package.json`, `src/cli.js`, and `src/opencode-plugin.js`. Add test helpers that record npm and client commands. Cover both symlinks, reruns, PATH output, safety, client results, and Windows:

```js
test("installs dependencies, the CLI, and the OpenCode plugin", () => {
  const npmCalls = [];
  const result = runSetup({
    ...fixture,
    env: { PATH: path.join(fixture.homeDirectory, ".local", "bin") },
    runNpmInstall: (directory) => npmCalls.push(directory),
    runCommand: unavailableClients,
  });

  assert.deepEqual(npmCalls, [fixture.checkoutDirectory]);
  assert.equal(fs.realpathSync(result.cli.path), fixture.cliPath);
  assert.equal(fs.realpathSync(result.opencode.path), fixture.opencodeSourcePath);
  assert.equal(result.path, "available");
  assert.deepEqual(result.integrations, {
    claude: { status: "unavailable" },
    codex: { status: "unavailable" },
  });
});

test("reports the PATH command when ~/.local/bin is absent", () => {
  const result = runSetup({ ...fixture, env: { PATH: "/usr/bin" }, runCommand: unavailableClients });
  assert.equal(result.path, "missing");
  assert.equal(result.pathInstruction, 'export PATH="$HOME/.local/bin:$PATH"');
});

test("refuses to replace an unrelated executable", () => {
  const destination = path.join(fixture.homeDirectory, ".local", "bin", "taskferry");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "unrelated");
  assert.throws(() => runSetup({ ...fixture, runCommand: unavailableClients }), /refusing to replace/);
});

test("installs Claude and reports the Codex desktop step", () => {
  const result = runSetup({ ...fixture, runCommand: configuredClients });
  assert.equal(result.integrations.claude.status, "installed");
  assert.equal(result.integrations.codex.status, "desktop-install-required");
  assert.match(result.integrations.codex.next, /Codex desktop/);
});

test("rejects Windows before npm, links, or client commands", () => {
  assert.throws(() => runSetup({ ...fixture, platform: "win32" }), /Unix domain sockets/);
  assert.equal(npmCalls.length, 0);
  assert.equal(commandCalls.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `node --test src/setup.test.js`

Expected: FAIL because `src/setup.js` does not exist.

- [ ] **Step 3: Implement the dependency-free service**

Create `src/setup.js` with only `node:child_process`, `node:fs`, `node:os`, and `node:path` imports. Use this public function shape:

```js
export function runSetup({
  checkoutDirectory,
  cliPath,
  homeDirectory = os.homedir(),
  env = process.env,
  platform = process.platform,
  runNpmInstall = defaultNpmInstall,
  runCommand = defaultRunCommand,
}) {
  if (platform === "win32") {
    throw new Error("taskferry setup requires Unix domain sockets and is unavailable on Windows");
  }

  runNpmInstall(checkoutDirectory);
  const binPath = path.join(homeDirectory, ".local", "bin", "taskferry");
  const opencodePath = path.join(env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config"), "opencode", "plugins", "taskferry.js");
  replaceManagedSymlink(binPath, cliPath);
  replaceManagedSymlink(opencodePath, path.join(checkoutDirectory, "src", "opencode-plugin.js"));

  const binDirectory = path.dirname(binPath);
  const onPath = (env.PATH || "").split(path.delimiter).some((entry) => path.resolve(entry) === binDirectory);
  return {
    cli: { path: binPath, source: cliPath },
    opencode: { path: opencodePath, source: path.join(checkoutDirectory, "src", "opencode-plugin.js") },
    dependencies: "installed",
    path: onPath ? "available" : "missing",
    ...(onPath ? {} : { pathInstruction: 'export PATH="$HOME/.local/bin:$PATH"' }),
    integrations: {
      claude: installClaude(checkoutDirectory, runCommand),
      codex: registerCodex(checkoutDirectory, runCommand),
    },
  };
}
```

Implement `replaceManagedSymlink(destination, source)` to create the parent directory, inspect an existing destination with `lstatSync`, and only unlink it when it is a symlink resolving to `src/cli.js` or `src/opencode-plugin.js` inside a checkout whose adjacent `package.json` has `{ "name": "taskferry" }`. Otherwise throw `error: refusing to replace unmanaged path: <destination>`. Create the replacement with `fs.symlinkSync(source, destination, "file")`.

Implement `defaultNpmInstall` with `spawnSync("npm", ["install"], { cwd, encoding: "utf8" })`. Throw when `result.error` exists or `result.status !== 0`, including captured stderr in the error text. Implement `defaultRunCommand` with the same captured-output pattern.

Implement client setup with these exact commands:

```js
// Claude Code, only when `claude plugin marketplace list` is executable.
claude plugin marketplace list
claude plugin marketplace add <checkoutDirectory> // only when taskferry is absent
claude plugin list --json
claude plugin install taskferry@taskferry --scope user // only when absent
claude plugin update taskferry@taskferry // only when installed

// Codex, only when `codex plugin marketplace list` is executable.
codex plugin marketplace list
codex plugin marketplace add <checkoutDirectory> // only when taskferry is absent
codex plugin marketplace upgrade taskferry // only when taskferry is present
```

Treat only `ENOENT` from the first command as unavailable. Throw captured diagnostics for all other command failures. Parse Claude's installed JSON by matching `id === "taskferry@taskferry"`. Detect an existing `taskferry` marketplace from each client's list output. Return this Codex result after its marketplace command succeeds:

```js
{
  status: "desktop-install-required",
  next: "Open Codex desktop, install Taskferry from its marketplace, then review and trust its hooks.",
}
```

- [ ] **Step 4: Run the setup tests**

Run: `node --test src/setup.test.js`

Expected: PASS with idempotent links, npm execution, PATH reporting, protected destinations, client installation outcomes, and Windows rejection covered.

- [ ] **Step 5: Commit the setup service**

```bash
git add src/setup.js src/setup.test.js
git commit -m "feat(setup): install local integrations"
```

### Task 2: Add the CLI Bootstrap Command

**Files:**
- Modify: `src/args.js:1-391`
- Modify: `src/args.test.js:5-79`
- Modify: `src/cli.js:1-83`
- Modify: `src/cli.test.js:39-91`

**Interfaces:**
- Consumes: `runSetup` from `src/setup.js`.
- Produces: `parseArgs(["setup"])` with `{ command: "setup", options: {}, help: false }`.
- Produces: `runCli(["setup"], { setup })` without a daemon connection.

- [ ] **Step 1: Write failing command tests**

Replace the setup-rejection assertion in `src/args.test.js` with:

```js
assert.deepEqual(parseArgs(["setup"]), {
  command: "setup",
  options: {},
  help: false,
});
```

Add this to `src/cli.test.js`:

```js
test("runs setup without connecting to the daemon", async () => {
  const capture = capturedIo();
  let called = false;
  const result = await runCli(["setup"], {
    io: capture.io,
    setup: () => {
      called = true;
      return { cli: { path: "/home/test/.local/bin/taskferry" }, path: "available" };
    },
    connectClient: async () => { throw new Error("setup must not connect"); },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(called, true);
  assert.equal(capture.output().value.path, "available");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test src/args.test.js src/cli.test.js`

Expected: FAIL because `setup` is currently rejected.

- [ ] **Step 3: Route setup before dependency-backed imports**

Add a `setup` command specification with no options and examples `taskferry setup` and `node src/cli.js setup`. Remove the special setup rejection and return `{}` from `defaultOptions("setup")`.

In `src/cli.js`, keep static imports limited to Node built-ins, `parseArgs`, `UsageError`, and `runSetup`. Derive the checkout root from `fileURLToPath(import.meta.url)`. Call injected `setup` or `runSetup` before dynamically importing `commands.js`, `client.js`, or `output.js`:

```js
if (parsed.command === "setup") {
  const value = setup({
    checkoutDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    cliPath: fileURLToPath(import.meta.url),
    homeDirectory: os.homedir(),
    env,
  });
  const { writeToon } = await import("./output.js");
  writeToon(value, io);
  return { exitCode: 0, value };
}
```

Dynamically import the existing command, client, and output modules for all other commands. If setup fails before `npm install` succeeds, print `error: <message>` and `help: fix the reported dependency or filesystem problem, then rerun node src/cli.js setup` to stderr without loading `@toon-format/toon`.

- [ ] **Step 4: Verify command behavior**

Run: `node --test src/args.test.js src/cli.test.js`

Expected: PASS with the no-daemon setup branch and existing CLI behavior preserved.

Run: `npm run test:unit`

Expected: PASS.

- [ ] **Step 5: Commit the bootstrap command**

```bash
git add src/args.js src/args.test.js src/cli.js src/cli.test.js
git commit -m "feat(cli): bootstrap local setup"
```

### Task 3: Document Installation and Integration Status

**Files:**
- Modify: `README.md:81-100`
- Modify: `docs/cli-reference.md:14-16`
- Modify: `docs/troubleshooting.md:134-141`
- Modify: `docs/integrations/claude-code.md:7-18`
- Modify: `docs/integrations/codex.md:7-49`
- Modify: `docs/integrations/opencode.md:8-31`

**Interfaces:**
- Consumes: `node src/cli.js setup` after cloning and `taskferry setup` after updating.
- Produces: documentation that describes automatic CLI, OpenCode, and Claude setup plus the Codex desktop requirement.

- [ ] **Step 1: Update installation instructions**

Replace global npm installation examples with:

```bash
git clone https://github.com/jeremysball/taskferry.git
cd taskferry
node src/cli.js setup
taskferry --version
```

Document updates as:

```bash
git pull
taskferry setup
```

State that setup creates the CLI and OpenCode symlinks, installs dependencies, and prints `export PATH="$HOME/.local/bin:$PATH"` when needed. State that Taskferry does not support Windows because it requires Unix domain sockets.

- [ ] **Step 2: Update native integration guides**

In the Claude Code guide, replace manual marketplace commands with `taskferry setup` and state that it installs or updates the user-scoped plugin when `claude` is available. In the OpenCode guide, replace the package-array configuration with the automatically created `$XDG_CONFIG_HOME/opencode/plugins/taskferry.js` symlink. In the Codex guide, state that setup registers or refreshes the marketplace, then direct the user to install Taskferry and trust its hooks in the Codex desktop interface.

- [ ] **Step 3: Update the CLI reference and troubleshooting guide**

Add `setup` to the command list and document its dependency installation, symlink safety rules, client outcomes, and Codex desktop notice. Replace the hook PATH-recovery section with `taskferry setup`, the exact PATH export command, and the existing GUI-inherited-PATH warning.

- [ ] **Step 4: Verify documentation and repository checks**

Run: `npm run skill:check`

Expected: PASS because setup does not change generated skills.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/cli-reference.md docs/troubleshooting.md docs/integrations/claude-code.md docs/integrations/codex.md docs/integrations/opencode.md
git commit -m "docs(setup): document local installation"
```
