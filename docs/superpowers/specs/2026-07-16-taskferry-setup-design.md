# Taskferry Setup Design

## Goal

Provide a Unix-only `taskferry setup` command that makes the checkout's CLI
available as `taskferry` from the user's shell.

## Behavior

`taskferry setup` creates `~/.local/bin` when needed, then creates or replaces
`~/.local/bin/taskferry` with an executable symlink to the invoking checkout's
`src/cli.js`.

After installation, the command checks whether `~/.local/bin` appears in the
current process's `PATH`.

- When it appears, the command reports the installed path and that
  `taskferry` is available in the current shell.
- When it does not appear, the command reports the installed path and prints
  the exact POSIX shell command required to add `~/.local/bin` to `PATH`.

The command detects Windows and exits with a clear error explaining that
Taskferry requires Unix domain sockets. It does not attempt a Windows install.

## Safety

The command only changes `~/.local/bin/taskferry`. It rejects a destination
that is not a Taskferry-managed symlink, rather than replacing an unrelated
executable. Re-running setup updates the managed symlink to the current
checkout.

## Documentation

The README and native-integration prerequisites use `taskferry setup` as the
supported installation command. They remove the global npm-install alternative.

## Testing

Unit tests inject the home directory, platform, PATH, and filesystem helpers.
They cover initial installation, idempotent updates, PATH-present and
PATH-absent output, foreign-destination protection, and Windows rejection.
