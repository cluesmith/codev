---
approved: 2026-10-12
validated: [gemini, codex, claude]
---

# Plan: Bootstrap the governance docs from an existing codebase

**Specification**: [codev/specs/1797-adopt-bootstrap-the-governance.md](../specs/1797-adopt-bootstrap-the-governance.md)

## Executive Summary

The spec selects **Approach 2 with Approach 4 as its content half**: a dedicated, re-runnable
`codev bootstrap-docs` subcommand that owns everything deterministic (per-file eligibility,
launch, change detection, validation, consult, summary), and a new **bootstrap mode** in the
`update-arch-docs` skill that owns the content contract. `codev adopt` offers the command at
the end (after any conflict-merge session has exited); `codev update` prints a hint.

The work splits into six phases, ordered so each builds only on finished, tested pieces:

1. Pure library: placeholder classifier, non-empty-repo rule, hot/cold validator.
2. Content: skill bootstrap mode + sensitive-material rejection (four copies, with four-copy
   parity enforced by test) and the bootstrap prompt template.
3. Harness capability: "launch interactively with an initial task prompt", Claude + Codex,
   gated so an unrecognised command never inherits Claude's convention.
4. The `codev bootstrap-docs` core: eligibility, launch, change detection (reusing the
   existing consult tree tripwire, promoted to `lib/`), validation, summary.
5. Draft review: the 3-way consult on the drafts and its report.
6. `adopt` / `update` integration and user docs.

Decisions this plan makes that the spec deferred:

- **Git-log window (spec OQ5).** The CLI computes the survey itself, so the bound is
  deterministic rather than left to the agent: the last **300** commit subjects
  (`git log --no-merges --format='%h %ad %s' --date=short -n 300`) plus up to **150**
  targeted subjects from full history matching any of fix, revert, hotfix, incident,
  regression, rollback, outage, security (`git log --no-merges -i -E
  --grep='fix|revert|hotfix|incident|regression|rollback|outage|security' -n 150`; `-E` is
  required for the alternation), de-duplicated. The digest
  is inlined into the prompt. The agent may run further targeted `git show`/`git log -S` on
  specific commits but the prompt tells it not to walk the full log. No commits → the digest
  says so and the agent works from code alone.
- **Harness support (spec OQ2).** Verified empirically on 2026-10-13: `claude --help` and
  `codex --help` both document an optional positional `[PROMPT]` that starts the
  **interactive** session with that prompt (Claude's existing adopt merge launch already relies
  on this). Those two built-ins get the capability. OpenCode (builder-only harness, not
  installed for verification) and custom harnesses do not; they take the prompt-file fallback.
- **Known earlier starters.** From git history, the only earlier starter text is the pre-#1012
  cold variant (same lines, no `STARTER:` comment; commits `8ef441cc2`/`9fa9c2316`). Both it
  and the current starters predate the v3.2.0 tag, so only the current starters ever shipped
  in a release; the pre-#1012 variant is included anyway because it costs nothing and
  pre-release builds carried it. The hot starters have a single version (`1a8c63b27`).
- **Seeded universal lessons survive (architect addition at the spec gate).** The three
  universal lessons shipped in `lessons-critical.md` are carried into the bootstrapped hot
  file and are only displaced by a project-specific lesson when the 10-entry cap would
  otherwise be exceeded; a displaced one is demoted into `lessons-learned.md`, never dropped.
  This lives in the skill's bootstrap mode and the prompt (content), not the validator (which
  stays mechanical).
- **Prompt delivery.** The CLI inlines the skill's full `SKILL.md` text (read from the
  installed package skeleton via `getTemplatesDir()`'s sibling skill path, not from the
  adopter's repo) into the prompt, per the runtime-resolution rule. The agent is not told to
  fetch any `codev/...` framework path.
- **Fallback prompt file** goes to `.consult/bootstrap-docs/prompt.md` (gitignored, already
  exempt from the change detector), alongside the consult outputs.
- **Missing governance files are not eligible.** The spec gates rewriting on "classified as
  an untouched starter"; a missing file is not a starter. The command reports it and tells
  the user to run `codev update` (which restores the starter skip-existing) and re-run. This
  keeps eligibility strictly the spec's predicate (CMAP iter1, Codex).
- **Prompt template is skeleton-only.** It lives at
  `codev-skeleton/templates/bootstrap-docs-prompt.md` and is read from the installed package.
  `codev/templates/` is not a full mirror (it already omits both `*.starter.md` files, for the
  same reason: nothing reads them from the instance tree), so an instance copy would be an
  unconsumed drift surface. Our own instance gets the change through the skill copies and the
  CLI. (CMAP iter1, Claude.)
- **Change detection reuses `tree-tripwire.ts`.** `packages/codev/src/commands/consult/tree-tripwire.ts`
  (#1649) already snapshots `git status --porcelain -z --untracked-files=all` paths with
  content hashes, tolerates a repo with no commits, and diffs HEAD/branch identity, with the
  same documented limits (gitignored paths invisible). Its generic core moves to
  `packages/codev/src/lib/tree-snapshot.ts`; the consult module keeps its consult-specific
  ignore rules and re-exports. The bootstrap adds an index fingerprint on top (see Phase 4).
  (CMAP iter1, Claude; index per iter2, Codex.)
- **Scope of change detection (spec reading).** The spec's detector compares "the four files
  and the git state". Gitignored paths are not git state, so they are outside the detector
  in a git repo; hashing them (`node_modules/`, build output) would make every run slow and
  noisy for no review value, since ignored paths never reach a commit. The summary says this
  every time. CMAP iter3 (Codex) read the spec as requiring ignored paths too; this plan keeps
  the narrower reading and flags it for the plan gate.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Governance-doc classifier and validator library"},
    {"id": "phase_2", "title": "Skill bootstrap mode and bootstrap prompt template"},
    {"id": "phase_3", "title": "Harness capability for interactive task launch"},
    {"id": "phase_4", "title": "codev bootstrap-docs command core"},
    {"id": "phase_5", "title": "Three-way review of the drafts"},
    {"id": "phase_6", "title": "adopt and update integration plus docs"}
  ]
}
```

## Phase Breakdown

### Phase 1: Governance-doc classifier and validator library

**Dependencies**: None

#### Objective

All deterministic judgement the command needs, as pure, unit-tested functions with no I/O
beyond reading files and (for the repo rule) running `git ls-files`. Everything later phases
decide about eligibility and validity comes from here.

#### Files to Create / Modify

- Create `packages/codev/src/lib/governance-bootstrap.ts`
- Create `packages/codev/src/__tests__/governance-bootstrap.test.ts`
- Modify `packages/codev/src/__tests__/hot-tier.test.ts`: import the cap constants and the
  section/map helpers from the new library instead of its private copies (`CAP_*`,
  `bulletsUnder`, `topLevelHeadings`, `mapTopics`, `isRealSection`), so there is one
  definition of the hot-cap and map rules (CMAP iter2, Claude). Its stricter raw line count
  for shipped placements (comments included) stays as a test-local policy on top.
- Modify `packages/codev/src/lib/scaffold.ts` only if a shared constant (the four file names /
  starter source mapping) needs exporting; `HOT_TIER_FILES` and `COLD_TIER_FILES` are reused
  as-is.

#### Deliverables

- [ ] `GOVERNANCE_FILES`: the four files with kind (`hot`/`cold`), their starter source(s),
      and for hot files the paired cold doc.
- [ ] `knownStarterTexts(file, templatesDir)`: current skeleton starter + the pre-#1012 cold
      variant (embedded as a constant with a comment citing the commits).
- [ ] `classifyGovernanceFile(content, starters)` → `'missing' | 'placeholder' | 'curated'`
      implementing the spec predicate exactly: there exists **one** known starter version
      such that every non-blank line of the file appears **verbatim** among that version's
      lines (no trimming; the only normalisation is CRLF → LF, so a checkout with
      `core.autocrlf` is not misread as curated), **and** at least one starter marker is
      present (`_No … yet._` line, `- <…>` slot line, or a line containing `STARTER:`).
      Lines may not be mixed across starter versions. Any doubt ⇒ `curated`. `missing` is
      its own class and is **not** eligible (see Executive Summary).
- [ ] `isNonEmptyRepo(root)`: `git ls-files --cached --others --exclude-standard -z` inside
      a git work tree; otherwise a filesystem walk honouring `.gitignore` at the root plus the
      fixed Codev-generated exclusions (`codev/`, `.codev/`, `.claude/`, `.codex/`,
      `CLAUDE.md`, `AGENTS.md`, `*.codev-new`, `.gitignore`, and `.git/`). Submodule gitlinks
      count as files (they appear in `ls-files`).
- [ ] `validateHotFile(content, coldContent, kind)` → list of typed violations:
      leftover marker (slot line, `_No … yet._`, `STARTER:`); facts/lessons section > 10
      `- ` entries; map section > 12 `- ` entries; > 35 lines excluding HTML-comment lines;
      missing required section; map entry not starting with a real `## ` section name of
      the cold doc. Plus informational `unmappedSections` (always computed; a violation only
      when the cold doc has ≤ 12 top-level sections).
- [ ] `validateColdFile(content)` → leftover markers; > 12 top-level sections flagged only
      when the file was written by the pass (caller passes a flag).
- [ ] Map-entry matching rule: the one already shipped in `hot-tier.test.ts`, promoted and
      tightened, documented in code and fixed by tests:
  - the entry's **topic** is the text after `- ` up to the first ` — ` (the whole entry
    when there is none, so `- Security` alone is valid);
  - a topic names a section when it equals the `## ` heading text or is a word-boundary
    prefix of it (`heading.startsWith(topic + ' ')`), so `Critical` names
    `Critical (Prevent Major Failures)`;
  - new: the topic must name **exactly one** section; several matches are a violation
    (ambiguity), zero matches are a violation (non-existent section).
  - The existing hot-tier test keeps passing on our own files with this rule (verified
    shape: `- Critical — …` vs `## Critical (Prevent Major Failures)`).

#### Acceptance Criteria

- [ ] Shipped starters (all four, plus the pre-#1012 cold variant) classify as `placeholder`.
- [ ] `lessons-critical.md` exactly as shipped (three seeded lessons) is `placeholder`.
- [ ] A starter with one added real line, or with one slot line edited, is `curated`.
- [ ] A line with changed trailing whitespace is `curated`; a CRLF copy of a starter is
      `placeholder`. (The single-version rule is still implemented, but the pre-#1012 cold
      lines are a subset of the current starter's, so no shipped mix is distinguishable; the
      rule is tested with a synthetic two-version starter set instead.)
- [ ] A missing file classifies as `missing`.
- [ ] A starter with all markers removed but no other edits is `curated` (no marker ⇒ doubt).
- [ ] This repo's `codev/resources/arch-critical.md` + `arch.md` and
      `lessons-critical.md` + `lessons-learned.md` produce **no** violations (spec scenario 12;
      `arch.md` has 19 sections, so unmapped sections appear as information only).
- [ ] Each of: leftover slot, 11th fact, 13th map entry, 36 non-comment lines, map entry
      naming a non-existent section produces exactly the expected violation (scenario 11);
      an ambiguous topic (prefix of two headings) is a violation; a bare `- Section` entry is
      valid; `hot-tier.test.ts` stays green on the shared helpers.
- [ ] `isNonEmptyRepo`: only Codev-generated files ⇒ false; one untracked source file in a
      repo with no commits ⇒ true; an ignored file only ⇒ false; non-git directory with one
      source file ⇒ true.
- [ ] `pnpm build` and the package test suite pass; `tsc` type check passes.

#### Test Plan

Unit tests in `governance-bootstrap.test.ts` using temp directories (`fs.mkdtempSync`) and
real `git init` for the repo rule, reading starters from `codev-skeleton/templates/` via a
repo-root path (as `hot-tier.test.ts` does), so the tests need no prior `pnpm build`. Fixtures for over-cap and bad-map
cases are built inline from the real arch-critical file with targeted edits.

---

### Phase 2: Skill bootstrap mode and bootstrap prompt template

**Dependencies**: Phase 1 (the prompt template names the validator's rules; the skill text
must match them)

#### Objective

Own the content contract in one place. The `update-arch-docs` skill gains a third mode
(bootstrap) and a new bright-line rejection for sensitive material that applies to all modes.
A prompt template packages the per-run instructions the CLI fills in.

#### Files to Create / Modify

- Modify all four skill copies identically:
  - `.claude/skills/update-arch-docs/SKILL.md`
  - `.codex/skills/update-arch-docs/SKILL.md`
  - `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md`
  - `codev-skeleton/.codex/skills/update-arch-docs/SKILL.md`
- Create `codev-skeleton/templates/bootstrap-docs-prompt.md` (skeleton-only; rationale in the
  Executive Summary).
- Modify `packages/codev/src/__tests__/spec-1280-skills-parity.test.ts`: add
  `'update-arch-docs'` to `TOUCHED_SKILLS`. Today `skill-parity.test.ts` only compares
  `.claude` ↔ `.codex` within each tree and the four-tree byte check covers only
  `runnable-worktrees` and `codev`, so a forgotten skeleton pair would pass green.

#### Deliverables

- [ ] Skill frontmatter description: "Three modes" (diff, audit, bootstrap), bootstrap
      named as the first-population mode for an adopted codebase.
- [ ] New section `## Mode: bootstrap-mode (first population from a codebase)`:
  - survey order: build wiring / package manifests, entry points, process and service
    boundaries, persistence, transports, then the git-log digest supplied by the caller;
  - write only the files the caller lists as eligible; read curated governance files as
    input (a curated `arch.md` drives the map of a placeholder `arch-critical.md`);
  - cold `arch.md`: current system shape, ≤ 12 top-level `## ` sections, no file lists,
    no history, nothing aspirational;
  - cold `lessons-learned.md`: lessons evidenced by scar tissue (fix/revert/incident commits,
    "never do X" comments, recurring bug classes), each traceable to evidence; thin is
    acceptable, invented is not; organised in ≤ 12 top-level sections;
  - hot files: the exact shape from the spec's definitions (title, guidance comment with the
    `STARTER:` sentence removed, facts/lessons section, map section), ≤ 10 entries, map
    built from the cold doc's real top-level sections;
  - **seeded universal lessons survive**: the three seeded lessons stay in
    `lessons-critical.md` unless a project-specific lesson needs the slot under the cap; a
    displaced one is demoted into `lessons-learned.md`;
  - remove every slot line, `_No … yet._` line and `STARTER:` text from files it writes;
  - never commit, stage, or touch any other path; say clearly when done and ask the user to
    exit the session so the CLI can validate.
- [ ] New bright-line rejection under "What this skill does NOT do → In either file":
      no credentials, tokens, keys, internal hostnames/endpoints, connection strings, or
      customer data in any governance doc (all modes).
- [ ] Prompt template with placeholders the CLI fills: `{{SKILL}}` (full skill text),
      `{{ELIGIBLE_FILES}}`, `{{CURATED_FILES}}`, `{{GIT_DIGEST}}`, `{{PROJECT_NAME}}`, and a
      closing instruction block (writable paths only, exit when done, secrets reminder).
- [ ] Tests for this phase (below).

#### Acceptance Criteria

- [ ] All four skill copies are byte-identical, now enforced across trees by
      `spec-1280-skills-parity.test.ts`; `skill-parity.test.ts` green.
- [ ] No sentence in the skill or prompt instructs the agent to fetch a `codev/...`
      framework path (`codev/resources/*.md` governance files are user files and may be
      named). This is a **manual** read-through: `framework-ref-audit.ts` scans only
      `protocols/` and `roles/`.
- [ ] Build and full package test suite pass.

#### Test Plan

- Existing parity tests cover the four copies.
- New assertions in `governance-bootstrap.test.ts` (or a small `bootstrap-docs-prompt.test.ts`):
  the packaged template exists and contains every placeholder exactly once.
- Manual read-through of the rendered prompt against the spec's content contract.

---

### Phase 3: Harness capability for interactive task launch

**Dependencies**: None (independent of 1-2; ordered here so Phase 4 consumes it)

#### Objective

Add the optional harness capability the spec requires so the command does not hardcode
Claude flags, with the fallback decided by capability absence.

#### Files to Create / Modify

- Modify `packages/codev/src/agent-farm/utils/harness.ts`
- Modify the harness unit tests (existing `harness` test file under
  `packages/codev/src/agent-farm/__tests__/`; located during the phase)

#### Deliverables

- [ ] `HarnessProvider.buildInteractiveTaskLaunch?(prompt: string): { args: string[] }`,
      documented like `supportsContextReset`: optional, absence means unsupported, callers
      must fall back.
- [ ] `CLAUDE_HARNESS` and `CODEX_HARNESS` implement it as the positional prompt argument
      (`[prompt]`), verified against each CLI's `--help` (recorded in the doc comment with
      the verification date).
- [ ] OpenCode and custom harnesses do not implement it.
- [ ] `resolveInteractiveTaskLauncher(command, harnessName, customHarnesses)`: returns the
      capability only when the harness is identified **positively**, i.e. an explicit
      `shell.architectHarness` naming a built-in that declares it, or
      `detectHarnessFromCommand(command)` returning such a built-in. `resolveHarness`'s
      silent fall-through to `CLAUDE_HARNESS` for an unrecognised command is treated as
      unsupported, so `aider …` never receives Claude's positional prompt (CMAP iter1,
      Claude). Retired names surface the retirement message as "unsupported".
- [ ] A configured command that would run headless is unsupported too: for Claude, any of
      `-p` / `--print` among its flags; for Codex, any token equal to a known non-interactive
      subcommand from `codex --help` (`exec`, `e`, `review`, `login`, `logout`, `mcp`, …, held
      as a named list), not "first non-flag token", which would misread a flag value such as
      `--model gpt-5-codex` (CMAP iter3, Claude). The fallback message names the reason.
- [ ] `resolveInteractiveTaskLauncher` catches `RetiredHarnessError` (a detected `gemini`
      command makes `resolveHarness` throw) and returns "unsupported" with the retirement
      message, never letting the throw escape.
- [ ] Command tokenisation reuses the existing pattern for `shell.architect` (string split on
      whitespace as in `agent-farm/commands/architect.ts`, or the array form when config
      gives `string[]`): executable = first token, then configured flags, then the
      capability's args.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Claude and Codex return `[prompt]`; OpenCode and a custom provider return `undefined`
      for the capability.
- [ ] `resolveInteractiveTaskLauncher`: `claude --dangerously-skip-permissions` and
      `/opt/homebrew/bin/codex` resolve; `aider --model x` and a custom harness resolve to
      unsupported; an explicit `architectHarness: "codex"` with an odd command path resolves;
      `claude -p`, `claude --print` and `codex exec` resolve to unsupported with a reason.
- [ ] Existing harness tests stay green; type check passes.

#### Test Plan

Unit tests on the providers and on `resolveHarness` + capability presence for each built-in
and a custom config.

---

### Phase 4: `codev bootstrap-docs` command core

**Dependencies**: Phases 1, 2, 3

#### Objective

The user-facing, re-runnable pass from eligibility to summary, with all failure paths
reported and nothing destructive. The draft review is added in Phase 5.

#### Files to Create / Modify

- Create `packages/codev/src/commands/bootstrap-docs.ts`
- Create `packages/codev/src/lib/tree-snapshot.ts` by moving the generic core of
  `packages/codev/src/commands/consult/tree-tripwire.ts` (`snapshotTree`, the diff with a
  caller-supplied ignore predicate, `diffRepositoryIdentity`, `readIdentity`, `hashPath`)
- Modify `packages/codev/src/commands/consult/tree-tripwire.ts` to import/re-export from
  `lib/tree-snapshot.ts`, keeping its consult-owned ignore rules and warning formatters;
  existing tripwire tests stay green unchanged
- Add a non-git fallback in `lib/tree-snapshot.ts`: a filesystem snapshot (path → content
  hash) using the same walk as Phase 1's `isNonEmptyRepo` (root `.gitignore` honoured,
  `.git/` and `node_modules/` skipped), so source edits outside git are detected too
- Modify `packages/codev/src/cli.ts` (register `bootstrap-docs` with `--dry-run`; there is
  deliberately no `-y`, because the pass always confirms before launching an agent)
- Create `packages/codev/src/__tests__/bootstrap-docs.test.ts`
- Create `packages/codev/src/__tests__/tree-snapshot.test.ts` (non-git fallback + bootstrap-specific cases)

#### Deliverables

- [ ] Flow, in order:
  1. Locate the project root (cwd must contain `codev/`; otherwise error suggesting
     `codev adopt`).
  2. Classify the four files (Phase 1). A **missing** file is not eligible; it is listed with
     "run `codev update` to restore the starter, then re-run".
  3. If no file is eligible: print "nothing needs bootstrapping" with per-file status, exit 0,
     launch nothing (no-op re-run, scenario 2).
  4. If the repo is empty (Phase 1 rule): print the explanatory no-op, exit 0 (scenario 5).
  5. `--dry-run`: print eligibility and the resolved launch, exit 0.
  6. Build the prompt: render the Phase 2 template with the packaged skill text, eligible
     and curated lists, project name and git digest (window defined in the Executive Summary).
     The digest checks `git rev-parse --verify HEAD` first; a repo with no commits (or no
     git) gets "no commit history; work from the code alone" instead of a failing `git log`.
  7. Resolve the launcher with Phase 3's `resolveInteractiveTaskLauncher` from config
     (`shell.architect` / `shell.architectHarness` via `loadConfig`). If unsupported, or the
     executable is not on `PATH`: write the prompt to `.consult/bootstrap-docs/prompt.md`,
     print manual instructions, exit 0 without launching (scenario 15).
  8. Pre-launch statement + confirm (default **No**): the exact command that will run,
     that it reads the codebase and git log, the writable files, that it consumes model quota,
     and the permission mode inherited from config. Non-TTY stdin ⇒ treat as declined, print
     the command to run interactively.
  9. Snapshot (`lib/tree-snapshot.ts` + governance-file hashes), then spawn the agent with `stdio: 'inherit'` and **await**
     its exit (a Promise around `spawn`'s `exit`/`error`).
  10. Post-run: change report (below), validation of each eligible file (Phase 1),
      unwritten-eligible detection (file still classifies as placeholder, or was deleted).
  11. (Phase 5 inserts the draft review here.)
  12. Summary: files written, per-file validation result, out-of-scope changes, and an
      explicit "review before commit — nothing has been staged or committed" message.
- [ ] Exit code: non-zero when the change report names any out-of-scope change, a curated
      governance file changed, HEAD/index changed, or validation failed / an eligible file
      was left unwritten. Drafts are always kept; nothing is reverted.
- [ ] Change report, built on `lib/tree-snapshot.ts` plus direct content hashes of the four
      governance files (clean tracked files do not appear in porcelain, so curated files are
      hashed explicitly):
  - **exit-bearing**: a curated governance file changed; HEAD or branch moved; the index
    changed (SHA-256 of `git ls-files --stage -z`, because porcelain XY codes plus working
    hashes cannot see a re-stage of an already-staged path; CMAP iter2, Codex); any path
    other than an eligible file changed status or content;
  - **exempt**: eligible files and `.consult/` (the tripwire's existing consult-owned
    prefix), the only exemptions the spec allows;
  - known harness scratch paths (initially `.claude/settings.local.json`, which a
    non-bypass Claude session writes on a "don't ask again" answer) remain **exit-bearing**
    per the spec, but are annotated "written by the agent harness itself, usually benign" so
    the human can judge quickly. (Iter1 proposed making them informational; iter2 Codex
    pointed out the spec allows no such exemption.)
  - the agent's own exit status: a non-zero exit or spawn error is reported and is
    exit-bearing, with whatever drafts exist still kept and validated (CMAP iter2, Gemini).
  - The summary states the detector's scope: gitignored paths are not watched (git), or the
    walk's exclusions (non-git).
  - The non-git walk is bounded at 50,000 files; beyond that it stops and the summary says
    detection covered only the four governance files (CMAP iter3, Claude).
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] A missing governance file is reported, not created, and does not launch the agent on
      its own.
- [ ] Re-run on a populated result: no agent spawned, files byte-identical, exit 0
      (scenario 2).
- [ ] Empty repo and no-eligible-file paths launch nothing.
- [ ] Unsupported harness: prompt file written, nothing launched (scenario 15).
- [ ] A stub agent that writes valid drafts ⇒ exit 0, summary lists the files, nothing
      staged (`git diff --cached` empty) (scenario 1, minus real model).
- [ ] A stub agent that edits a curated file / a source file / makes a commit ⇒ each named,
      exit non-zero, nothing reverted (scenario 13).
- [ ] A stub agent that writes nothing or only some files ⇒ unwritten files reported, written
      drafts kept, exit non-zero (scenario 14).
- [ ] Mixed state (curated `arch.md` with > 12 sections, three placeholders): `arch.md`
      byte-identical; map entries checked against real sections; unmapped listed as info
      (scenario 3).
- [ ] A stub agent writing `.claude/settings.local.json` alongside valid drafts ⇒ path
      named with the harness annotation, exit non-zero.
- [ ] Pre-staged path re-staged with different content (working file unchanged) ⇒ index
      change reported.
- [ ] Stub agent exiting non-zero after writing valid drafts ⇒ reported, drafts kept, exit
      non-zero.
- [ ] Non-git directory: a stub agent editing a source file ⇒ named, exit non-zero.
- [ ] Existing `tree-tripwire` tests and `consult-readonly-review.e2e.test.ts` green after the
      move.
- [ ] Build, type check and full package suite pass.

#### Test Plan

Integration-style tests in temp git repos (and one non-git temp dir). The agent is a stub
injected through a dependency seam on the command (`runBootstrapDocs(opts, deps)` with
injectable `confirm`, `spawnAgent`, `resolveLauncher`, `stdinIsTTY`): `spawnAgent` performs
the scenario's writes in-process and resolves, so no real model runs and no prompt waits on
input (`confirm()` has no TTY guard and would never settle on EOF). `lib/tree-snapshot.ts`
gets unit tests for the non-git fallback; the git path is covered by the moved tripwire tests
plus: pre-existing dirt left alone ⇒ clean; new untracked file ⇒ reported; modified tracked
file ⇒ reported; commit ⇒ HEAD change; `git add` ⇒ reported; index-only change ⇒ reported.

---

### Phase 5: Three-way review of the drafts

**Dependencies**: Phase 4

#### Objective

Run the 3-way general consult on the drafts when consultation is available, save the
feedback where the human can find it, and never apply it.

#### Files to Create / Modify

- Modify `packages/codev/src/commands/bootstrap-docs.ts` (step 11 and the summary)
- Add the review prompt to `codev-skeleton/templates/bootstrap-docs-review-prompt.md`
- Extend `packages/codev/src/__tests__/bootstrap-docs.test.ts`

#### Deliverables

- [ ] When at least one eligible file was written: write the rendered review prompt (asks for
      system-shape accuracy against the repo, invented or unevidenced lessons,
      enumerations/changelog/aspirational content, cap/map problems, and **sensitive
      material**) and run
      `consult -m <gemini|codex|claude> --prompt-file <review prompt> --output
      .consult/bootstrap-docs/<model>.md` for the three models in parallel; wait for all.
      General mode with an explicit `--output` needs no project detection, so it works in a
      freshly adopted repo.
- [ ] Each failed or skipped reviewer is named; if `consult` cannot be spawned at all, warn
      and continue. Consult outcome never changes the exit code.
- [ ] Summary gains a one-line pointer to `.consult/bootstrap-docs/`.
- [ ] `runConsult` joins the injectable deps.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Nothing written ⇒ no consult.
- [ ] All three succeed ⇒ pointer printed; one fails ⇒ named, pass completes; `consult`
      missing ⇒ warning, pass completes (scenario 16).
- [ ] Consult outputs under `.consult/` never appear in the change report.
- [ ] Build, type check and full package suite pass.

#### Test Plan

Stubbed `runConsult` for each outcome; one assertion that the real argv built for each model
matches the consult CLI's registered options (`cli-options.ts`).

---

### Phase 6: adopt and update integration plus docs

**Dependencies**: Phases 4, 5

#### Objective

Put the pass where adopters meet it, without two agent sessions sharing the terminal, and
document it.

#### Files to Create / Modify

- Modify `packages/codev/src/commands/adopt.ts`
- Modify `packages/codev/src/commands/update.ts` (new `UpdateResult.bootstrapDocsHint`
  field carrying the signal)
- Modify `packages/codev/src/cli.ts` (the `--agent` JSON `instructions` object is built
  there; add `bootstrapDocs` from the new field)
- Modify `packages/codev/src/__tests__/adopt.test.ts` (and the update tests file). Two
  existing mocks must change or the suite breaks (CMAP iter1, Claude): the
  `node:child_process` mock's `spawn` returns an object whose `on` is a no-op, so an awaited
  merge child never settles (the conflict test would time out) — it must invoke the `exit`
  handler; and the `node:readline` mock answers `y` to every question, which would
  auto-accept the new bootstrap offer in every non-`-y` test — the offer must go through
  the injected seam and default to declining in existing tests. Third (CMAP iter2, Claude):
  the `node:child_process` mock exports only `spawn`, so `isNonEmptyRepo`'s `execFileSync`
  would be `undefined`; the mock must also export `execFileSync` (passing through to the real
  one via `vi.importActual`), or the repo check goes through the injected seam.
- Modify `codev/resources/commands/codev.md` (command reference; `codev/resources/commands/`
  has no skeleton twin, verified during the phase) and the skeleton's adopt-facing docs if
  they describe post-adopt steps (grep both trees for "codev adopt")
- Modify `README.md` / `INSTALL.md` adopt section only if they describe the post-adopt
  governance step (grep first)

#### Deliverables

- [ ] `adopt`: the conflict-merge `claude` spawn becomes awaited (Promise on `exit`/`error`;
      error path unchanged: print manual merge instructions). The "Next steps" block moves to
      the very end of `adopt`, after the merge session and the optional bootstrap. Only
      after the merge session resolves:
      - `-y`: never launch; if the repo is non-empty and files are eligible, print
        "run `codev bootstrap-docs` to draft the governance docs from this codebase".
      - interactive, non-empty repo, eligible files: ask "Draft the governance docs from this
        codebase now?" (default No); yes ⇒ call the Phase 4 entry point (which still shows its
        own pre-launch statement and confirm); no ⇒ print the command.
      - empty repo: no offer, no hint (placeholders stay; scenario 5).
- [ ] `update`: after the hot/cold backfill, if any governance file classifies as
      placeholder and the repo is non-empty, print one hint line pointing at
      `codev bootstrap-docs`. Not shown in `--agent` JSON mode's stdout (added as an
      `instructions.bootstrapDocs` string instead) and not shown on `--dry-run`.
- [ ] Docs: `codev bootstrap-docs` entry in the command reference (purpose, flow, what it
      writes, exit codes, `--dry-run`, manual fallback); adopt's "Next steps" mentions it.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] `adopt -y` never launches the bootstrap agent and prints the command when eligible
      (scenario 7).
- [ ] With a CLAUDE.md conflict, the bootstrap offer is reached only after the merge child
      has exited (scenario 8), asserted by ordering of injected stubs.
- [ ] Empty repo: no offer, no hint.
- [ ] `update` prints the hint exactly once when placeholders remain on a non-empty repo and
      not at all after a populated result (scenario 4).
- [ ] Build, type check and full package suite pass; parity tests green.

#### Test Plan

Extend `adopt.test.ts` with stubbed `confirm`/spawn seams (adopt gains the same small
injectable-deps parameter, defaulting to the real implementations) for ordering and `-y`
behaviour; extend update tests for the hint. Manual: run `codev adopt` on a scratch copy of
a small real repository to check the end-to-end terminal experience.

---

### Review-phase gate item (not an implementation phase)

Real-repo verification (spec scenario 18) is owned by the builder in the review phase and
recorded in the review document: run `codev bootstrap-docs` on a real pre-existing repository
other than this one, confirm project-specific hot tier with no slots, cold archives matching
the real system shape, cap respected, and a re-run that changes nothing.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Awaiting adopt's merge session changes adopt's behaviour for existing users | Medium | Medium | Only the timing changes (adopt now returns after the session); error path kept; covered by ordering test |
| Long inlined prompt (skill + digest) exceeds argv limits | Low | Medium | Digest is bounded (≤ 450 subject lines); total well under macOS/Linux `ARG_MAX`; if the rendered prompt exceeds a conservative 100 KB, fall back to the prompt file + instructions |
| Classifier false "placeholder" on a lightly curated file | Low | High | Subset-AND-marker predicate, doubt ⇒ curated; tests for half-edited starters; output is uncommitted |
| Change detector false positives from tools the agent runs (e.g. lockfile churn, harness settings) | Medium | Low | Known harness scratch paths are annotated "usually benign" (still exit-bearing per spec); nothing is reverted; the human decides |
| Map-entry matching too strict for natural phrasing | Medium | Low | Name-part vs heading/short-name rule; our own curated hot files are the regression fixtures |
| Moving tripwire code breaks consult's read-only review guard | Low | Medium | Move plus one signature change (`diffTreeSnapshots`'s `ignore: string[]` becomes a caller-supplied predicate; consult passes its existing rules); existing tripwire + e2e tests must stay green unchanged |
| Consult cost/latency on every run | Low | Low | Runs only when something was written; parallel; failures non-blocking |
| Codex positional-prompt behaviour changes upstream | Low | Low | Capability is per harness; doc comment records the verification date; fallback exists |

## Documentation Updates

- `update-arch-docs` skill (four copies): bootstrap mode + sensitive-material rejection.
- New skeleton templates: `bootstrap-docs-prompt.md`, `bootstrap-docs-review-prompt.md`.
- `codev/resources/commands/codev.md`: new `bootstrap-docs` command; adopt's next steps.
- `codev/resources/arch.md` / `lessons-learned.md` (and hot tier only if a fact earns a slot):
  routed in the review phase per the two-tier rules.
