# taskferry

Read `docs/sourcemap.md` at the start of any session in this repo before
exploring the codebase further. It orients on the call chain, file-by-file
responsibilities, env vars, and the gotchas that look like bugs but aren't.

## Check GitHub issues after merging a PR

After merging a PR in this repo, check open GitHub issues (`gh-axi issue list
--state open`) for any the merge resolves, and close each with `gh-axi issue
close <number> --reason completed --comment "<why>"`. Don't assume a merge
closes nothing just because the PR body didn't say "Closes #N" — cross-check
the actual diff against open issue descriptions.
