import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { opencodeExecutor, piExecutor, resolveExecutor } from "./executor.js";



describe("piExecutor()", () => {
  test("exposes pi identity and defaults", () => {
    const ex = piExecutor();
    assert.equal(ex.id, "pi");
    assert.equal(ex.taskIdPrefix, "pi");
    assert.equal(ex.errorBucketPrefix, "pi");
    assert.equal(ex.defaultModel, "minimax/MiniMax-M2.7");
  });

  test("buildSpawnArgs splits provider/model and supports session", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: false, model: "minimax/MiniMax-M2.7", launchDirectory: "/work", promptFilePath: null, prompt: "hi", sessionId: "ses" }), ["--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json", "--session", "ses", "-p", "hi"]);
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: false, model: "gpt-4o", launchDirectory: "/work", promptFilePath: "/p", prompt: "huge", sessionId: null }), ["--model", "gpt-4o", "--mode", "json", "-p", "Follow the instructions in the attached prompt file exactly.", "@/p"]);
  });

  test("buildSpawnArgs uses snapshot attachment for summaries", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: true, model: "minimax/MiniMax-M2.7", launchDirectory: "/work", snapshotPath: "/s.json", prompt: "", sessionId: null }), ["--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json", "-p", ex.buildSummaryPrompt(), "@/s.json"]);
  });

  test("listModelsFn normalizes pi's padded table output from stderr", async () => {
    const table = "Provider Model\nminimax  MiniMax-M2.7  extra\nopenai  gpt-4o\n\n";
    const ex = piExecutor({ execFileFn: async () => ({ stdout: "", stderr: table }) });
    assert.equal(await ex.listModelsFn({}), "minimax/MiniMax-M2.7\nopenai/gpt-4o");
  });

  test("sandboxAuthFile binds auth and overrides pi data directory", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.sandboxAuthFile({ homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" }, existsFn: (p) => p === "/custom/pi/auth.json" }), {
      extraRoBind: ["/custom/pi/auth.json", "/state/run/pi-data/auth.json"],
      sandboxedDataHome: "/state/run/pi-data",
      sandboxEnv: { PI_CODING_AGENT_DIR: "/state/run/pi-data" },
    });
  });

  test("resolveExecutor resolves pi to a pi executor", () => {
    assert.equal(resolveExecutor("pi").id, "pi");
  });

  test("sandboxAuthFile falls back to ~/.pi", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({ homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: {}, existsFn: (p) => p === "/home/user/.pi/auth.json" });
    assert.deepEqual(result.extraRoBind, ["/home/user/.pi/auth.json", "/state/run/pi-data/auth.json"]);
  });
});

describe("opencodeExecutor()", () => {
  test("id/taskIdPrefix/errorBucketPrefix", () => {
    const ex = opencodeExecutor();
    assert.equal(ex.id, "opencode");
    assert.equal(ex.taskIdPrefix, "oc");
    assert.equal(ex.errorBucketPrefix, "opencode");
  });

  test("buildSpawnArgs: plain dispatch", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "openai/gpt-5.6-luna", variant: null,
      launchDirectory: "/work/dir", promptFilePath: null, prompt: "do the thing", sessionId: null,
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", "openai/gpt-5.6-luna", "--", "do the thing"]);
  });

  test("buildSpawnArgs: dispatch with variant and session resume", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "openai/gpt-5.6-luna", variant: "high",
      launchDirectory: "/work/dir", promptFilePath: null, prompt: "do the thing", sessionId: "ses_1",
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", "openai/gpt-5.6-luna", "--continue", "--session", "ses_1", "--variant", "high", "--", "do the thing"]);
  });

  test("buildSpawnArgs: prompt routed through a file", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "openai/gpt-5.6-luna", variant: null,
      launchDirectory: "/work/dir", promptFilePath: "/state/prompts/t1.prompt.txt", prompt: "huge prompt", sessionId: null,
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", "openai/gpt-5.6-luna", "-f", "/state/prompts/t1.prompt.txt", "--", "Follow the instructions in the attached prompt file exactly."]);
  });

  test("buildSpawnArgs: summary launch", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: true, model: "opencode/hy3-free", launchDirectory: "/state/summaries",
      snapshotPath: "/state/summaries/oc_1.json", prompt: "", sessionId: null,
    });
    assert.deepEqual(args, [
      "run", "--dir", "/state/summaries", "--pure", "--agent", "taskferry-summary", "--format", "json", "-m", "opencode/hy3-free",
      "-f", "/state/summaries/oc_1.json", "--", ex.buildSummaryPrompt(),
    ]);
  });

  test("normalizeLogEvent is the identity function", () => {
    const ex = opencodeExecutor();
    const evt = { type: "text", part: { text: "hi", messageID: "m1" } };
    assert.equal(ex.normalizeLogEvent(evt), evt);
  });

  test("sandboxAuthFile: binds real auth.json when present", () => {
    const ex = opencodeExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: {},
      existsFn: (p) => p === "/home/user/.local/share/opencode/auth.json",
    });
    assert.deepEqual(result, {
      extraRoBind: ["/home/user/.local/share/opencode/auth.json", "/state/run/opencode-data/opencode/auth.json"],
      sandboxedDataHome: "/state/run/opencode-data",
      sandboxEnv: { XDG_DATA_HOME: "/state/run/opencode-data" },
    });
  });

  test("sandboxAuthFile: no bind when auth.json is missing", () => {
    const ex = opencodeExecutor();
    const result = ex.sandboxAuthFile({ homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: {}, existsFn: () => false });
    assert.equal(result.extraRoBind, null);
  });

  test("resolveExecutor: undefined and \"opencode\" both resolve to opencodeExecutor", () => {
    assert.equal(resolveExecutor(undefined).id, "opencode");
    assert.equal(resolveExecutor("opencode").id, "opencode");
  });

  test("resolveExecutor: unknown name throws", () => {
    assert.throws(() => resolveExecutor("bogus"), /unknown executor: bogus/);
  });
});
