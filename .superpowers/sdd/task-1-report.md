# Task 1 Report: Setup Service And Symlinked Entrypoint Fix

## Summary

Implemented `runSetup()` in `src/setup.js` exactly as specified in the brief, plus the prerequisite fix to `src/cli.js` that lets the direct-execution guard recognise a symlink invocation. Both ship with their own TDD coverage; the brief's five-step test plan is exercised as six passing cases.

## Prerequisite Fix: Symlinked Entrypoint

`src/cli.js:78` previously compared `path.resolve(process.argv[1])` against `fileURLToPath(import.meta.url)`. `path.resolve` does not follow symlinks, but the ESM loader resolves `import.meta.url` through any symlink, so a `~/.local/bin/taskferry` symlink invocation would land on the literal symlink path while `import.meta.url` reported the real `src/cli.js`. The guard never matched, `main()` never ran, and the process exited 0 with no output.

Fix: resolve `process.argv[1]` through `fs.realpathSync` before the comparison, with a `path.resolve` fallback for missing paths:

```js
if (process.argv[1] && resolveInvokedPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeError(error);
    process.exitCode = 1;
  });
}

function resolveInvokedPath(invoked) {
  try {
    return fs.realpathSync(invoked);
  } catch {
    return path.resolve(invoked);
  }
}
```

Regression test in `src/cli.test.js` (`executes main() when invoked through a symlink to src/cli.js`): creates a symlink to the real `src/cli.js` in a tmp dir, spawns the symlink via `execFileSync(process.execPath, [link, "--version"])`, and asserts the decoded TOON output has `name === "taskferry"` and a non-empty `version`. Verified the test catches the bug: with the old guard restored, the new test fails with `actual: undefined, expected: "taskferry"`; with the fix it passes.

## Setup Service

`src/setup.js` ships the dependency-free service in the brief:

- `runSetup({ checkoutDirectory, cliPath, homeDirectory, env, platform, runNpmInstall, runCommand })` returns `{ cli, opencode, dependencies, path, pathInstruction?, integrations }`.
- `replaceManagedSymlink(destination, source)`: creates the parent dir, lstat-inspects the existing destination, only unlinks it when the resolved target is `src/cli.js` or `src/opencode-plugin.js` inside a checkout whose `package.json` names `taskferry`. Any other path throws `refusing to replace unmanaged path: <destination>`. Idempotent on rerun.
- `defaultNpmInstall` uses `spawnSync("npm", ["install"], { cwd, encoding: "utf8" })` and throws on `result.error` or non-zero status, including captured stderr in the error text.
- `defaultRunCommand` uses the same captured-output pattern and forwards `error.code` (so `ENOENT` propagates for the client probe).
- `installClaude` and `registerCodex` probe with `plugin marketplace list`, treat only `ENOENT` as unavailable, run the documented add/install/upgrade/update sequence, and throw with captured stderr on any other failure. Claude install/update is driven by `--json plugin list` and an `id === "taskferry@taskferry"` check. Codex returns `desktop-install-required` with the desktop guidance after its marketplace command succeeds.
- Windows rejection happens first in `runSetup`, before npm, link creation, or client commands.

## Tests

TDD evidence:

- RED: `node --test src/setup.test.js` failed with `ERR_MODULE_NOT_FOUND` for `./setup.js` before implementation.
- GREEN: `node --test src/setup.test.js` passes 6/6 tests:
  - `installs dependencies, the CLI, and the OpenCode plugin`
  - `reports the PATH command when ~/.local/bin is absent`
  - `refuses to replace an unrelated executable`
  - `installs Claude and reports the Codex desktop step`
  - `rejects Windows before npm, links, or client commands`
  - `rerun replaces the existing managed symlinks without throwing` (covers the brief's "idempotent links" expectation)

Final verification:

- `env -u TASKFERRY_KEY_SLOTS -u TASKFERRY_PROVIDER_KEY_ENV -u TASKFERRY_CHILD npm test`: 191 passed, 0 failed.
- `npm run lint`: clean, exit 0.
- `npm run typecheck`: clean, exit 0.

## End-To-End Proof

Beyond the unit test, `scripts/e2e-setup.js` exercises the full install path the brief cares about:

1. Builds a tmp "checkout" by symlinking the real `src/` and `package.json` from the repo.
2. Calls `runSetup` against it, with a no-op `runNpmInstall` and an ENOENT-returning `runCommand`.
3. Asserts the resulting `~/.local/bin/taskferry` is a symlink that resolves to the real `src/cli.js`, and the OpenCode plugin symlink resolves to the real `src/opencode-plugin.js`.
4. Spawns the installed symlink as a real subprocess (`execFileSync(process.execPath, [binLink, "--version"])`) and asserts the decoded TOON output is the real taskferry version object — proving the symlink is the same path the user would run after `taskferry setup`, and that the guard fix actually unblocks it.

Output of `node scripts/e2e-setup.js`:

```json
{
  "binLink": "/tmp/taskferry-e2e-home-b7CrRB/.local/bin/taskferry",
  "resolved": "/workspace/taskferry/.worktrees/taskferry-setup/src/cli.js",
  "version": {
    "name": "taskferry",
    "version": "2.0.0",
    "protocolVersion": 1
  },
  "pluginPath": "/tmp/taskferry-e2e-home-b7CrRB/.config/opencode/plugins/taskferry.js",
  "pluginResolved": "/workspace/taskferry/.worktrees/taskferry-setup/src/opencode-plugin.js"
}
E2E PASS: setup-service-installed symlink produces real CLI output
```

Without the guard fix, the same script (and any user invocation of `~/.local/bin/taskferry`) exits 0 with empty stdout.

## Commits

- `b208bc2` `fix(cli): resolve symlinked entrypoint before the direct-execution guard`
- `1d46a60` `feat(setup): install local integrations`

## Files Changed

- Modified `src/cli.js`
- Modified `src/cli.test.js`
- Added `src/setup.js`
- Added `src/setup.test.js`
- Added `scripts/e2e-setup.js`
- Added `.superpowers/sdd/task-1-report.md`

## Self-Review

- The fixture helper in `src/setup.test.js` is the only fixture used by all six tests; no test reaches into real files outside its tmp checkout.
- The "refuses to replace an unrelated executable" test creates a regular file at the destination and asserts the same `refusing to replace unmanaged path: <destination>` error string the brief specifies.
- `installClaude` and `registerCodex` keep the "only when taskferry is absent/present" conditionals per the brief's command list, and re-check after each step rather than caching state.
- `scripts/e2e-setup.js` is committed alongside the setup service so the same end-to-end check is reproducible from a fresh clone.
