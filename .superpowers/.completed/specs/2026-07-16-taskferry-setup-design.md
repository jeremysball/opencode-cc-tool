# Taskferry Setup Design

## Goal

Provide a Unix-only `taskferry setup` command that installs the current
checkout, makes its CLI available as `taskferry` from the user's shell, and
remains safe to rerun after every `git pull`. A fresh clone must bootstrap
without installed npm dependencies.

## Behavior

The CLI parses and executes `setup` using only Node built-in modules. It loads
the normal command modules only after handling `setup`, so a fresh clone can
run:

```bash
node src/cli.js setup
```

`setup` runs `npm install` in the current checkout, creating or updating its
dependencies from the checked-out `package-lock.json`. It then installs the
following managed symlinks:

- `~/.local/bin/taskferry` to the invoking checkout's `src/cli.js`.
- `$XDG_CONFIG_HOME/opencode/plugins/taskferry.js` to the checkout's
  `src/opencode-plugin.js`, defaulting `XDG_CONFIG_HOME` to `~/.config`.

The OpenCode plugin symlink lets OpenCode load the checkout directly, without
a globally installed npm package.

The symlink runs the checkout's source directly through `src/cli.js`'s Node
shebang. A `git pull` therefore updates the code used by the next invocation;
re-running `taskferry setup` refreshes dependencies and confirms the symlink:

```bash
git pull
taskferry setup
```

When `claude` appears on `PATH`, setup registers this checkout as its
`taskferry` marketplace and installs or updates its `taskferry` plugin in user
scope. When `codex` appears on `PATH`, setup registers or refreshes its
`taskferry` marketplace. Codex requires plugin installation and hook trust in
the desktop interface, so setup reports that required manual step. When a
client is absent, setup reports it as unavailable and continues. A failure
from an available client's integration command fails setup with that command's
captured diagnostic; rerunning remains safe.

After installation, the command checks whether `~/.local/bin` appears in the
current process's `PATH`.

- When it appears, the command reports the installed path and that
  `taskferry` is available in the current shell.
- When it does not appear, the command reports the installed path and prints
  the exact POSIX shell command required to add `~/.local/bin` to `PATH`.

The command detects Windows and exits with a clear error explaining that
Taskferry requires Unix domain sockets. It does not attempt a Windows install.

## Safety

The command changes only its two managed symlink paths and agent-client plugin
registrations. It rejects a destination that is not a symlink to a Taskferry
source file, rather than replacing an unrelated executable. Re-running setup
updates each managed symlink to the current checkout and refreshes installed
agent integrations.

## Documentation

The README and native-integration prerequisites use `node src/cli.js setup`
for a fresh clone and `taskferry setup` for updates. They remove the global
npm-install alternative and manual marketplace-registration commands.

## Testing

Unit tests inject the home directory, platform, PATH, and filesystem helpers.
They cover dependency-free bootstrap dispatch, initial installation,
idempotent updates, PATH-present and PATH-absent output, foreign-destination
protection, dependency installation, OpenCode plugin linking, available and
unavailable Claude Code/Codex clients, integration-command failures, the
Codex desktop-install notice, and Windows rejection.
