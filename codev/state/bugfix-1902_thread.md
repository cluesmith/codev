# bugfix-1902 thread

Prompt sweep outside `protocols/pir/`: broken commands, the porch-approve contradiction, three
owner rulings, and stale text across roles, skills, templates and non-PIR protocols.

## Investigate (2026-11-15)

Started. Verifying each claim in the issue against the CLI source before editing (the sweep is
evidence, not ground truth).

### Verified against the CLI source (3.3.7, this worktree)

All A–D claims checked; every one reproduced. Evidence worth keeping:

- **A1** `consult -m claude --type integration pr 1899` → `Unknown subcommand: pr`. Correct: `--type integration --issue <N>`.
- **A2** `consult()` throws `Cannot use both --prompt and --prompt-file` (index.ts ~2505).
- **A3** `porch run` → exit 1, "'porch run' has been removed". `porch verify <id> --skip` exists.
- **A4** bare `--type <t>` resolves `consult-types/<t>-review.md`; only `integration-review.md` exists there.
- **A5** `--context` is `readFileSync(path)`; `-` is just a missing file (warning, ignored).
- **A6** `afx spawn --protocol nonexistentxyz --help` → exit 0. The only command that fails on an
  unknown protocol is a real spawn, too heavy to use as a probe → dropping the check.
- **B/C2** porch's `normalizePhase` reads `verify`, never a phase's `consultation` block. So
  BUGFIX/AIR `consultation: {models: [gemini, codex], type: impl}` is dead data, and the PR-phase
  prompt hardcodes three `consult` lines. Concretely: this repo's `.codev/config.json` sets
  `porch.consultation.models: ["codex","claude"]`, yet every BUGFIX builder here runs gemini too.
- **Signals**: nothing in packages/ parses `<signal>`, `signals`, `on_too_complex`,
  `awaiting_input` (type exists, never set), or `defaults.consultation`.
- **Commits**: porch commits only `status.yaml` (`writeStateAndCommit`); `on_complete.commit`
  is parsed and never used (`getOnCompleteConfig` imported, unused). Builder must commit.
- **Branches**: `builder/<protocol>-<id>` (spawn.ts). **afx send**: exact id, else tail match
  with leading zeros stripped — `afx send 42` works; nothing needs zero-padding.
- **doctor** AI list: Claude (Agent SDK), Codex, OpenCode, Gemini via agy.
- **MAINTAIN** consult-types impl/pr-review are byte-identical to SPIR's.
- **Schema**: no `build_verify`, gate is object-only (most files use a string), checks require
  `command` (plan checks are strings, bugfix `regression_test` has none), no `alias`,
  `phase_completion`, `build`, `verify`, `max_iterations`, `on_complete`, `next`, input `none`.

### Extra drift found (fixing in place)

- `afx`/`porch` skills differ between repo-local (`.claude`, `.codex`) and skeleton copies; local
  porch still documents `phase_completion` overrides (porch never runs those). Making all four
  copies identical and adding afx/porch/consult to the four-tree parity test.
- `codev/templates/{CLAUDE,AGENTS,cheatsheet}.md` are stale skeleton copies (still list TICK).
- `codev/resources/{cheatsheet,commands/overview,commands/agent-farm}.md`, both
  `workflow-reference.md`: `porch run`, TICK, `--amends`, `integration pr`.
- Hot fact in `codev/resources/arch-critical.md`: gate list is SPIR-only.

### Plan

Text edits everywhere, plus one small porch change for C2: parse a phase's `consultation`
(models + type) and render `{{consult_commands}}` / `{{consult_verdicts}}` in phase prompts via
the existing `resolveConsultationModels` (the same resolver `porch next` uses for verify), so the
project's configured lanes are what the builder runs. Regression test: a sweep test over both
trees for the removed patterns + a porch test for the rendering + schema validation of every
protocol.json.

### For the architect (not rewriting): RELEASE protocol

`codev/protocols/release/protocol.md` has the architect `git commit` + `git push` to main
(lines ~21-23, 83-85, 101-103), names notes `docs/releases/vX.Y.Z.md` while the real files are
`vX.Y.Z-<codename>.md`, and its codename table stops at 1.3.0 Doric.

## Fix (2026-11-15/16)

Done, in five commits on the branch (porch code; protocols; roles/templates/resources/root docs;
skills; regression sweep).

### Decisions

- **C2 mechanism**: a once phase can declare `consultation: {type, models}`; porch renders
  `{{consult_commands}}` / `{{consult_verdicts}}` through `resolveConsultationModels`. BUGFIX and AIR
  PR phases declare `{type: pr, models: [gemini, codex, claude]}`. A malformed block throws at load
  (no shipped protocol.json, past or present, has one). AIR's CMAP stays optional, but uses the
  configured lanes when it runs.
- **Commit format**: `[Bugfix #N] Fix:` / `Test:` everywhere (matches root CLAUDE.md).
- **PR timing (SPIR/ASPIR)**: opened in the Review phase; its `pr_exists` check requires it.
- **MAINTAIN removals**: `git rm` for tracked files, `.trash/<date>/` for untracked, never committed.
- **Escalation target (AIR)**: "SPIR or ASPIR".
- **A6**: the `afx spawn --help` protocol check is dropped. Unrecognised names: look in the three
  protocol dirs, else ask.
- **Schema**: one draft-07 schema, three identical copies, `context_refresh` block verbatim; a test
  validates all 18 protocol.json files (PIR included, read-only) with a small in-test validator
  (no ajv in the tree; unsupported keywords throw).

### Surprises

- **`porch <cmd> --help` executed the command.** Verifying prompts with `--help` ran
  `porch done --help`, i.e. `porch done bugfix-1902`, checks and all. I stopped it before it
  finished; porch state was untouched (still `fix`). Fixed in place: `--help`/`-h` after any
  subcommand prints help and returns, with a regression test. The globally installed porch still
  has the bug until the next release.
- **Spec 1280 deletion guard** tripped on 10 prompts (removals the issue requires). Its register
  needs architect approval, so I asked instead of re-baselining. The architect (main) approved R7
  on 2026-11-16 after checking the porch-source claims. Re-baselined, guard kept. I kept every
  baseline line that didn't have to go (ASPIR builder-prompt lines restored verbatim).
- `codev/resources/commands/agent-farm.md` documented `afx ports`, `workspace start -p/-c/--remote`,
  none of which exist. Removed in both trees.

### Left alone (out of scope, flagged)

- `INSTALL.md` is pre-v2 throughout (SPIDER, Ruler, copying protocols, TICK); a single-line fix
  would not help. Candidate for its own issue.
- The two `resources/commands/*.md` trees have drifted heavily (codev/ has porch, team,
  add-architect sections the skeleton lacks). I fixed what was broken in both; syncing them is a
  separate job.
- RELEASE: see above, for the architect.

### Verification

- Every command the prompts name: `--help` through this branch's binaries (32 invocations, all
  exit 0), and each documented flag grep-checked in the help text. Negative probes: the old
  `--type integration pr 1` and `--prompt` + `--prompt-file` forms fail with the errors the issue
  described.
- `bugfix-1902-prompt-sweep.test.ts`: 29 checks, 28 of which fail against a HEAD snapshot of
  the pre-fix tree.
