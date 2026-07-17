import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup } from "./setup.js";

function makeFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-setup-home-"));
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-setup-checkout-"));
  const src = path.join(checkout, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "taskferry" }));
  fs.writeFileSync(path.join(src, "cli.js"), "export {};\n");
  fs.writeFileSync(path.join(src, "opencode-plugin.js"), "export {};\n");
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  return {
    checkoutDirectory: checkout,
    cliPath: path.join(src, "cli.js"),
    opencodeSourcePath: path.join(src, "opencode-plugin.js"),
    homeDirectory: home,
  };
}

function unavailableClients() {
  return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
}

function makeRecordingClients(behavior) {
  return (command, args) => {
    behavior.calls.push({ command, args });
    return behavior.next(command, args);
  };
}

function configuredClients(command, args) {
  if (command === "claude") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return { status: 0, stdout: "[]", stderr: "", error: null };
    }
    if (args[0] === "plugin" && (args[1] === "install" || args[1] === "update")) {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  if (command === "codex") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  throw new Error(`unexpected client command: ${command} ${args.join(" ")}`);
}

test("installs dependencies, the CLI, and the OpenCode plugin", (t) => {
  const fixture = makeFixture(t);
  const npmCalls = [];
  const commandCalls = [];
  const tracking = { calls: commandCalls, next: unavailableClients };
  const result = runSetup({
    ...fixture,
    env: { PATH: path.join(fixture.homeDirectory, ".local", "bin") },
    runNpmInstall: (directory) => { npmCalls.push(directory); },
    runCommand: makeRecordingClients(tracking),
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

test("reports the PATH command when ~/.local/bin is absent", (t) => {
  const fixture = makeFixture(t);
  const result = runSetup({ ...fixture, env: { PATH: "/usr/bin" }, runCommand: unavailableClients });
  assert.equal(result.path, "missing");
  assert.equal(result.pathInstruction, 'export PATH="$HOME/.local/bin:$PATH"');
});

test("refuses to replace an unrelated executable", (t) => {
  const fixture = makeFixture(t);
  const destination = path.join(fixture.homeDirectory, ".local", "bin", "taskferry");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "unrelated");
  assert.throws(() => runSetup({ ...fixture, runCommand: unavailableClients }), /refusing to replace/);
});

test("installs Claude and reports the Codex desktop step", (t) => {
  const fixture = makeFixture(t);
  const commandCalls = [];
  const result = runSetup({
    ...fixture,
    runCommand: makeRecordingClients({ calls: commandCalls, next: configuredClients }),
  });
  assert.equal(result.integrations.claude.status, "installed");
  assert.equal(result.integrations.codex.status, "desktop-install-required");
  assert.match(result.integrations.codex.next, /Codex desktop/);
});

test("rejects Windows before npm, links, or client commands", (t) => {
  const fixture = makeFixture(t);
  const npmCalls = [];
  const commandCalls = [];
  assert.throws(
    () => runSetup({
      ...fixture,
      platform: "win32",
      runNpmInstall: (directory) => { npmCalls.push(directory); },
      runCommand: makeRecordingClients({ calls: commandCalls, next: unavailableClients }),
    }),
    /Unix domain sockets/,
  );
  assert.equal(npmCalls.length, 0);
  assert.equal(commandCalls.length, 0);
});

test("rerun replaces the existing managed symlinks without throwing", (t) => {
  const fixture = makeFixture(t);
  const env = { PATH: path.join(fixture.homeDirectory, ".local", "bin") };
  const first = runSetup({ ...fixture, env, runCommand: unavailableClients });
  const second = runSetup({ ...fixture, env, runCommand: unavailableClients });

  assert.equal(fs.realpathSync(second.cli.path), fixture.cliPath);
  assert.equal(fs.realpathSync(second.opencode.path), fixture.opencodeSourcePath);
  assert.equal(second.cli.path, first.cli.path);
  assert.equal(second.opencode.path, first.opencode.path);
});
