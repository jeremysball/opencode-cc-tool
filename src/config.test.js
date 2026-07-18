import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigPath, loadConfig } from "./config.js";

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-config-test-"));
}

function writeConfig(dir, content) {
  const configDir = path.join(dir, "taskferry");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, content);
  return configPath;
}

describe("resolveConfigPath()", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    const result = resolveConfigPath({ XDG_CONFIG_HOME: "/xdg-config" });
    assert.equal(result, path.join("/xdg-config", "taskferry", "config.json"));
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const result = resolveConfigPath({});
    assert.equal(result, path.join(os.homedir(), ".config", "taskferry", "config.json"));
  });
});

describe("loadConfig()", () => {
  test("returns {} when the file is missing", () => {
    const dir = tmpConfigDir();
    const configPath = path.join(dir, "taskferry", "config.json");
    assert.deepEqual(loadConfig({ configPath }), {});
  });

  test("returns the parsed object for a valid file", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ maxConcurrentTasks: 8, summaryModel: "opencode/hy3-free" }));
    assert.deepEqual(loadConfig({ configPath }), { maxConcurrentTasks: 8, summaryModel: "opencode/hy3-free" });
  });

  test("throws with error:/help: on malformed JSON", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, "{ not json");
    assert.throws(() => loadConfig({ configPath }), /error: could not parse.*\nhelp:/s);
  });

  test("throws on a non-object top-level value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, "[1, 2, 3]");
    assert.throws(() => loadConfig({ configPath }), /error: .*must contain a JSON object.*\nhelp:/s);
  });

  test("throws on an unrecognized top-level key", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ notARealKey: 1 }));
    assert.throws(() => loadConfig({ configPath }), /error: unrecognized config key "notARealKey".*\nhelp:/s);
  });

  test("throws on a wrong-typed field", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ maxConcurrentTasks: "4" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "maxConcurrentTasks".*must be a number.*\nhelp:/s);
  });

  test("keySlots reuses parseKeySlots's validation and error text", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ keySlots: "malformed-no-colon" }));
    assert.throws(() => loadConfig({ configPath }), /error: malformed TASKFERRY_KEY_SLOTS entry:.*\nhelp:/s);
  });

  test("accepts a valid keySlots value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ keySlots: "primary:OPENCODE_GO_API_KEY" }));
    assert.deepEqual(loadConfig({ configPath }), { keySlots: "primary:OPENCODE_GO_API_KEY" });
  });
});
