import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { opencodeExecutor, resolveExecutor } from "./executor.js";

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
