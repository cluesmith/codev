# Phase 4 iter2 rebuttal

Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude REQUEST_CHANGES.

## Claude

1. **Project root in a subdirectory of its repository (mis-keyed paths, `<absent>` hashes).**
   Accepted; fixed in `lib/tree-snapshot.ts`. `snapshotTree` reads `git rev-parse
   --show-prefix`, hashes each porcelain path at the repository top level, and keys it
   relative to the workspace (a path outside the project becomes `../…`, still reported). At
   the top level (prefix `''`) keys are unchanged, so consult's tripwire behaves as before;
   all consult tests are green. New test: a project at `apps/svc/` of a larger repo passes
   with valid drafts (exit 0) and names both an in-project source edit (`src/main.ts`) and an
   edit elsewhere in the repo (`../../other/readme.md`).
2. **Minor: the "nothing needs bootstrapping" headline ignores missing files.** Fixed: when a
   file is missing, it adds "Missing files are not created here: run `codev update` …".
3. **Minor: flaky `session-manager` test skipped in this PR.** Kept, per the builder role's
   flaky-test rule (rationale in the iter1 rebuttal); recorded for `## Flaky Tests` and to be
   raised with the architect for a tracking issue.
4. **Minor: the CLI ignores SIGINT for the agent's whole lifetime.** Intended. The agent owns
   the terminal for that whole time, and Ctrl-C reaches the whole foreground process group;
   without the no-op handler, interrupting the agent kills the CLI before it can report what
   the session changed. The handler is removed as soon as the agent exits, and the agent
   itself still receives the signal.

## Codex

1. **`null → SHA` HEAD transitions ignored (first commit in an unborn repository).**
   Accepted; fixed. `readIdentity` now recognises an unborn branch (`git symbolic-ref`
   succeeds where `rev-parse HEAD` fails) and marks it; `diffRepositoryIdentity` compares an
   unborn HEAD as `(no commits)`, so a first commit (or a move back to an unborn branch) is
   reported. "Could not tell" (not a repository, git error) is still skipped. New test: an
   empty first commit in an unborn repository with drafts left unstaged ⇒ HEAD change, exit 1.
2. **Summary always says "nothing has been staged or committed".** Fixed: when HEAD, the branch
   or the index moved, it says Codev staged and committed nothing but git state moved during
   the session, and points at `git log` / `git diff --cached`. The test asserts the
   unconditional sentence is absent in that case.
