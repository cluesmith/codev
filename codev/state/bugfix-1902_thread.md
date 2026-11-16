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
