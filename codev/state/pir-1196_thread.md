# PIR #1196 thread

- Resumed the existing `builder/pir-1196` branch in the plan phase. The branch
  is based on contributor commit `25e1a000`, which added a byte-identical
  self-hosted `.codex/skills/` mirror of the root `.claude/skills/` tree.
- Investigation found that `copySkills()` and all three scaffold lifecycle
  commands are hard-coded to `.claude/skills/`; `codev-skeleton/.codex/skills/`
  is absent and no provider-parity guard exists.
- Plan decision: materialize both provider paths from the embedded skeleton,
  centralize provider iteration, preserve existing skill directories per
  provider, and enforce recursive byte parity with an explicit (initially
  empty) provider-specific exception allowlist.
- Implemented provider-qualified skill copying for init/adopt/update, added the
  seven-skill shipped Codex skeleton mirror, updated both provider docs, and
  added recursive parity plus lifecycle preservation coverage.
- Verification: dependency/core/types/artifact/codev build chain passed; 58
  targeted tests passed; built-CLI smoke tests passed for fresh init, adopt,
  and update. The first full-suite run exposed host contamination from the
  global Codex config and `/tmp/.git`; rerunning porch checks with isolated
  `HOME`/`TMPDIR` passed the build and all 3,525 executed tests (48 existing
  skips). No tests were skipped or modified to mask failures.
- Dev-gate feedback: restored `codev-skeleton/templates/{AGENTS,CLAUDE}.md`
  unchanged and removed those files from the plan's implementation/test scope.
  Provider-location documentation remains in lifecycle output, provider
  skills, and the self-hosted root instruction pair.
- Dev approval completed. Review phase routes the current materialization model
  to COLD `arch.md` and the general duplicate-tree parity/preservation pattern
  to COLD `lessons-learned.md`; no HOT displacement is warranted.
- Single-pass consultation: Gemini APPROVE; Codex REQUEST_CHANGES. Accepted the
  stale init/adopt module-header finding and corrected both comments. Rebutted
  the claimed review scope error: GitHub reports 59 PR files, while consult
  reported 27 because local `main` already contains contributor commit
  `25e1a000`; the review now explains that baseline difference explicitly.
