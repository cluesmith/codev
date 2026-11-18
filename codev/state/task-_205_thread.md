# task-_205 thread

## 2026-11-18: Windows note for the repo's pnpm scripts

Task: document that on native Windows pnpm runs root scripts through `cmd.exe`, so `pnpm build`
and `pnpm local-install` (which invoke `.sh` files) fail until `script-shell` points at Git Bash.

**Placement.** The only place that documents local build/install for contributors is the `codev`
skill's "Local build and install (this repository)" section. README has a two-line Contributing
section with no build instructions, and there is no CONTRIBUTING.md, so the note went into the
skill, directly under the `local-install` paragraph.

**Why four files and a `.ts` changed in a docs PR.** The skill is one logical document held in
four physical copies, and `spec-1280-skills-parity.test.ts` requires the `codev` skill to be
byte-identical across all four (root and skeleton, Claude and Codex). So editing only the root
copies was not an option, whatever the audience of that section. A changed shipped skill also
needs `packages/codev/src/lib/shipped-skill-hashes.ts` regenerated (generated file, two new
hash lines, one per provider), otherwise `codev update` would treat the new text as a user edit.

**Verification.** The four copies are identical (`cmp`). The hash file was regenerated with the
repo's own generator. The worktree has no `node_modules`, so I did not run vitest locally; the
parity and skill-refresh tests run in CI on the PR. The fix itself was verified by the architect
on Windows 11; this machine already has `script-shell` set to the Git Bash path.

No `package.json` or script changes. CLAUDE.md / AGENTS.md untouched.
