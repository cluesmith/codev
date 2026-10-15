---
approved: 2026-10-12
validated: [gemini, codex, claude]
---

# Specification: Bootstrap the governance docs from an existing codebase

## Problem Statement

`codev adopt` on a codebase with real history leaves all four governance docs as placeholders:

- the COLD archives `codev/resources/arch.md` and `lessons-learned.md` hold only the starter line
  (`_No architecture documented yet._` / `_No lessons captured yet._`);
- the HOT tier `arch-critical.md` / `lessons-critical.md` holds angle-bracket template slots
  (`- <A system-shape fact …>`), plus three seeded universal lessons in `lessons-critical.md`.

The hot tier is injected into every porch phase prompt and, via the `@import` managed block,
into every interactive CLAUDE.md/AGENTS.md session (Spec 987). On an adopted project it
therefore injects template slots, not project knowledge, until a human hand-authors four
files. Nothing in Codev covers that first population: MAINTAIN and the `update-arch-docs`
skill both assume the docs already exist and only audit or diff them.

Who is affected: every team adopting Codev on a mature codebase. The first thing they hit
after `codev adopt` is an undocumented manual authoring pass, and until they do it the
always-on context is noise. An upcoming Jira-tracked onboarding will hit this immediately.

The "architecture emerges from review phases" assumption is correct for `codev init`
(greenfield) and wrong for `codev adopt` on a running system, where the architecture and the
scar tissue already exist in the code and the git log.

## Current State

- `adopt` (and `update` as a backfill) calls `copyHotTierDefaults` and `copyColdTierDefaults`,
  both skip-existing. They copy `templates/arch-critical.md`, `templates/lessons-critical.md`,
  `templates/arch.starter.md` → `arch.md`, `templates/lessons-learned.starter.md` →
  `lessons-learned.md`. No content is derived from the project.
- The cold files are registered as protected user data (never overwritten by `update`).
- The starters carry recognisable markers: a `<!-- STARTER: … -->` comment and the
  `_No … yet._` line (cold); a 7-line header comment that holds both the cap/displacement
  guidance and a `STARTER:` sentence, plus `- <…>` slot lines (hot). No code currently
  recognises "this file is still a starter".
- `adopt` already launches an interactive `claude` session with a prompt to merge
  `CLAUDE.md`/`AGENTS.md` `.codev-new` conflicts; `codev import` does the same for protocol
  imports. Both are fire-and-forget: `adopt` spawns with inherited stdio and returns without
  awaiting the child's exit.
- When the user accepts adopt's permission prompt, `.codev/config.json` records
  `claude --dangerously-skip-permissions` as the architect and builder command.
- The `HarnessProvider` abstraction covers role injection, session resume and worktree files;
  it has no uniform "launch with an initial task prompt" contract.
- The `update-arch-docs` skill (four shipped copies: `{.claude,.codex}/skills` ×
  `{repo root, codev-skeleton}`) encodes the routing rules (arch vs lessons, hot vs cold), the
  hot cap (≈10 entries + ≈12-topic map, ≤35 lines), displacement, and the bright-line
  rejections (no file lists, no changelog, no aspirational state). It has diff-mode and
  audit-mode only; neither covers generating docs from a codebase.
- `consult` supports a general mode (`--prompt` / `--prompt-file`) across the three
  reviewers, with Gemini skipping non-blockingly when unavailable. `.consult/` is already a
  gitignored, consult-owned output directory.
- Reference point: this repo's curated `arch-critical.md` is 32 lines (10 facts + a 12-topic
  map, guidance comment dropped), while its `arch.md` has 19 top-level sections, so the map
  deliberately covers only the 12 most decision-relevant ones.

Workaround today: the adopter writes the four files by hand, or asks an agent ad hoc with no
shared rules, which tends to produce file enumerations and aspirational content that the
skill would reject.

## Desired State

Adopting Codev on an existing codebase produces a **reviewed first draft** of the four
governance files, derived from the codebase and its git history, left **uncommitted** for the
human to review and commit.

- A single, re-runnable **bootstrap pass** exists as a `codev` subcommand. It runs an agent
  with the `update-arch-docs` rules (in a new bootstrap mode) over the code shape, build
  wiring, entry points, persistence, process boundaries and a bounded window of the git log,
  and:
  1. writes cold `arch.md` (current system shape) and cold `lessons-learned.md` (lessons from
     the repo's scar tissue: incident fixes in the log, "never do X" comments, recurring bug
     classes; thin is acceptable, invented is not);
  2. routes the load-bearing facts and lessons into the hot files within the cap, and builds
     each hot file's "consult when…" map from the cold doc's actual top-level sections;
  3. leaves the result uncommitted with a clear "review before commit" message;
  4. runs a 3-way consult on the draft when consultation is available, saves the feedback to
     a gitignored file, and points the human at it without auto-applying it.
- The pass is **gated per file**: only files classified as untouched starters are eligible
  for rewriting. A curated file is read as input instead (e.g. a curated `arch.md` feeds the
  map of a still-placeholder `arch-critical.md`).
- Because an interactive agent cannot be sandboxed by the CLI, the guarantee is
  **detect-and-report**: the CLI snapshots the four files and the git state before launch
  and, afterwards, reports loudly (non-zero exit) if a curated governance file changed, if
  HEAD or the index changed, or if any path other than the eligible files was modified.
  Nothing is reverted automatically; the human decides.
- `codev adopt` offers the pass at the end, interactively, on a non-empty repository, and
  only after any conflict-merge agent session it launched has exited. On an empty repository
  the placeholders remain and no pass is offered.
- A project that adopted earlier and still has placeholders can run the pass later; `codev
  update` prints a one-line hint when it sees placeholders on a non-empty repository.
- Re-running on an already-populated result is a no-op: nothing qualifies, no agent is
  launched, nothing changes.
- After the agent session ends, the CLI deterministically validates the result (definitions
  below) and reports violations instead of silently accepting them. Drafts are kept on disk
  whether or not validation passes.

### Definitions

- **Placeholder (eligible) file.** A governance file is a placeholder iff (a) every non-blank
  line in it also appears verbatim in the shipped starter for that file (current starter, or a
  known earlier shipped starter), **and** (b) it still carries at least one starter marker
  (`_No … yet._` line, a `- <…>` slot line, or the `STARTER:` comment). Anything else is
  curated. This treats `lessons-critical.md`'s three seeded lessons as starter content (they
  are in the shipped starter), treats any added or edited line as curation, and resolves every
  doubt toward "curated".
- **Non-empty repository.** The project contains at least one file, tracked or untracked but
  not ignored (in a git repo: `git ls-files --cached --others --exclude-standard`; outside
  git: a filesystem walk honouring the same exclusions), outside the Codev-generated set:
  `codev/`, `.codev/`, `.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`, `*.codev-new`,
  `.gitignore`. A repository with uncommitted code but no commits is non-empty (the pass then
  works from the code alone). Submodule entries count as files.
- **Hot-file shape the bootstrap writes.** The title line, the guidance comment with its
  `STARTER:` sentence removed (cap and displacement guidance kept), a `## Critical facts` /
  `## Critical lessons` section, and a `## Map of <cold doc>` section.
- **Hot cap, as validated.** Counted per section, not per file: ≤10 `- ` entries under the
  facts/lessons section; ≤12 `- ` entries under the map section; ≤35 lines total excluding
  HTML comment lines. (Our own 32-line exemplar passes.)
- **Map validity.** Every map entry must start with the name of a real top-level (`## `)
  section of its cold doc (map → cold, always enforced). Full coverage (every cold section in
  the map) is required only when the cold doc has ≤12 top-level sections; above that the
  validator lists unmapped sections as information, never a failure. Cold docs the bootstrap
  itself writes are kept to ≤12 top-level sections so their maps can be complete.

## Success Criteria

- [ ] On a non-empty pre-existing repository (not this one), the pass produces all four files
      with project-specific content and **no** remaining slot lines, `_No … yet._` lines, or
      `STARTER:` text.
- [ ] Each hot file passes the hot-cap rule as defined above.
- [ ] Each hot map passes the map-validity rule as defined above.
- [ ] The cold `arch.md` describes the actual system shape (verified by the human against the
      repo); it contains no per-file enumeration, per-spec changelog, aspirational content,
      credentials, tokens, internal endpoints, or customer data.
- [ ] If a curated governance file changes during the pass, or HEAD/the index changes, or a
      path other than an eligible file is modified, the CLI names it and exits non-zero.
      In the normal case, curated files are byte-identical before and after.
- [ ] Re-running the pass on the populated result changes no file, launches no agent, and
      reports that nothing needs bootstrapping.
- [ ] The pass itself never commits, stages, or pushes; it ends with an explicit "review
      before commit" message listing the files written and the validation result.
- [ ] When consultation is available, a 3-way general consult runs on the draft and its
      feedback is saved under `.consult/` with a one-line pointer printed; each unavailable or
      failed reviewer is named, and the pass still completes. If `consult` cannot run at all,
      the pass completes with a warning.
- [ ] `codev adopt` on an empty repository leaves the placeholders and does not offer the pass.
- [ ] `codev adopt -y` never launches the bootstrap agent; it prints how to run the pass.
- [ ] `codev adopt` never has two agent sessions on the terminal at once: the bootstrap offer
      appears only after the conflict-merge session (if any) has exited.
- [ ] The validator flags each of: leftover slot/marker, over-cap section, a map entry naming
      a non-existent cold section, an eligible file left unwritten.
- [ ] Unsupported or missing agent harness: the pass does not launch anything, leaves the
      placeholders, writes the bootstrap prompt to a file, and tells the user how to run it in
      their own agent.
- [ ] Framework change lands in both trees (`codev/` and `codev-skeleton/`); the skill change
      lands in all four shipped copies with the parity tests green.
- [ ] Unit tests cover the placeholder classifier (including seeded lessons and a
      half-edited starter), the non-empty-repo rule, the validator (cap counting, map
      direction, >12-section cold docs), the change-detection report, and the no-op re-run.

## Constraints

- **Skip-existing stays the rule for curated content.** Eligibility is per file and
  conservative (definition above).
- **Detection, not prevention.** The CLI cannot stop an interactive agent from writing
  elsewhere; it must detect and report, and must never auto-revert.
- **Two-tree rule.** Framework changes go in both `codev/` and `codev-skeleton/`; skills land in
  all four shipped copies, kept identical (parity tests enforce this).
- **Runtime resolution.** Framework content (the bootstrap prompt, skill text) is delivered
  through the package/resolver or inlined into the launched prompt, not by instructing an
  agent to fetch a `codev/...` path.
- **Harness neutrality.** Launch behaviour lives behind the harness abstraction, as an
  optional capability ("launch interactively with an initial task prompt"), not as hardcoded
  Claude flags in the new command. Built-in harnesses that support it are the ones the plan
  verifies empirically; a harness without it falls back to "prompt written to a file + manual
  instructions".
- **Permission mode is the user's.** The pass launches the project's configured agent
  command as-is, including a permission-bypass flag the user opted into at adopt time. Before
  launching, the CLI states in plain language what it will run, that it will read the
  codebase and git log, which files it may write, and that it consumes model quota, and asks
  for confirmation.
- **Content contract.** The `update-arch-docs` rules plus a new bright-line rejection for
  sensitive material: no credentials, tokens, keys, internal hostnames/endpoints, connection
  strings, or customer data in any governance doc. This rule applies to all modes of the
  skill, not just bootstrap.
- **Bounded survey.** The git-log survey is bounded (a recent window plus targeted searches
  for incident/fix/revert commits), so cost on large monorepos stays predictable.
- **No destructive operations.** The pass never commits, stages, deletes, or rewrites history.
- No Baked Decisions section exists in the issue; the issue's fix shape is a hypothesis.

## Assumptions

- The adopter has at least one supported agent CLI installed (`codev doctor` already checks
  this). If not, the manual fallback applies.
- When there is no git history, `lessons-learned.md` may stay thin; that is acceptable.
- The current starter templates (plus any earlier shipped starter text, which the plan
  enumerates from git history) are the definition of "placeholder".
- The CLAUDE.md/AGENTS.md managed block uses `@import` lines, so populated hot files reach
  interactive sessions without regenerating the block. Porch injection reads the files live.

## Solution Approaches

### Approach 1: Opt-in step baked into `codev adopt` only

At the end of `adopt`, ask "Draft the governance docs from this codebase now?" and launch the
agent.

- Pros: zero discovery cost; hits adopters at exactly the right moment.
- Cons: not re-runnable on a project that adopted earlier or declined; `adopt` refuses to run
  when `codev/` exists, so a second attempt has no entry point. Fails the issue's
  re-runnability requirement on its own.
- Risk: low complexity, but incomplete.

### Approach 2: Dedicated `codev` subcommand, offered by `adopt` (recommended)

A new subcommand (working name `codev bootstrap-docs`) that: classifies the four files →
exits as a no-op if none is eligible or the repo is empty → confirms with the user → snapshots
files and git state → launches an interactive agent session with the bootstrap prompt (the
skill's bootstrap mode, the eligible-file list, the curated files to read as input) and waits
for it to exit → validates the drafts and reports out-of-scope changes → runs the 3-way
consult when available → prints the "review before commit" summary. `adopt` offers it after
its own merge session (if any) exits; `-y` prints the command. `update` prints a hint.
A `--dry-run` reports eligibility without launching anything.

- Pros: re-runnable anywhere; idempotent by construction (per-file gating); testable CLI
  surface; keeps all deterministic work (eligibility, detection, validation, consult) out of
  the agent; matches existing "CLI hands a task to an agent" precedents.
- Cons: one new command to document; drafting still depends on an agent session; the CLI
  must now await an agent's exit (new plumbing, unlike the fire-and-forget precedents).
- Risk: moderate. The interesting work is the prompt quality and the validator.

### Approach 3: A MAINTAIN entry point (porch-driven bootstrap mode)

Add a bootstrap variant of MAINTAIN, run through `afx spawn --protocol maintain`.

- Pros: reuses porch's consultation and PR machinery; output lands as a reviewable PR.
- Cons: requires Tower, a builder worktree and the full afx stack on a project adopted
  minutes ago; MAINTAIN's semantics (audit since a base commit) don't fit a first
  population; not usable from the adopt flow.
- Risk: high ceremony, poor fit for onboarding.

### Approach 4: Skill-only (add a bootstrap mode to `update-arch-docs`, no CLI change)

Document a bootstrap mode in the skill and tell adopters to ask their agent to use it.

- Pros: smallest change; works in any agent session.
- Cons: still a manual step from the adopter's view; no gating, detection, validation,
  consult, or adopt integration.
- Risk: low, but does not meet the success criteria.

**Recommendation: Approach 2, with Approach 4 as its content half.** The rules for *what* a
bootstrapped doc contains live in the `update-arch-docs` skill (new bootstrap mode plus the
sensitive-material rejection), so the one skill stays the owner of the content contract and an
agent invoked any other way gets the same rules. The CLI owns everything deterministic.

## Open Questions

**Critical:** none. The issue leaves placement to the builder; this spec decides it.

**Important** (resolved here, confirm at the spec gate):

1. **Interactive vs headless run.** Decided: interactive, CLI awaits exit. The prompt tells
   the agent to say clearly when the draft is complete and that the user should exit the
   session so validation can run. Headless is not pursued because it needs per-harness
   non-interactive and tool-permission flags.
2. **Harness vs hardcoded `claude`.** Decided: through an optional harness capability, with
   the manual-prompt fallback. Which built-in harnesses get it is verified empirically in the
   plan.
3. **Consult feedback location.** Decided: `.consult/bootstrap-docs/` (already gitignored and
   consult-owned), exempt from the out-of-scope-change detector.

**Nice-to-know:**

4. Command name (`codev bootstrap-docs` vs a `codev docs` group). Recommendation: flat
   subcommand, consistent with the existing flat command set.
5. Exact git-log window size. Plan decides; the constraint is that it is bounded.

## Test Scenarios

Functional:

1. **Happy path, fresh adopt.** Adopt on a non-empty repo with history, accept the offer; all
   four files are written, the validator passes, consult runs and its file is pointed to,
   nothing is committed, the summary lists the four files.
2. **Re-run is a no-op.** Run the pass again on the result; no file changes, no agent launched.
3. **Mixed state.** `arch.md` curated (>12 sections), the other three placeholders: `arch.md` is
   byte-identical; `arch-critical.md`'s map names only real `arch.md` sections; unmapped
   sections are listed as information.
4. **Late adopter.** Adopted earlier, placeholders still in place; the subcommand bootstraps
   them; `codev update` printed the hint beforehand.
5. **Empty repo.** Only Codev-generated files present: `adopt` leaves placeholders and does not
   offer the pass; the subcommand exits with an explanatory no-op.
6. **Uncommitted code, no commits.** Classified non-empty; pass runs from code alone.
7. **Non-interactive adopt.** `adopt -y` launches no agent and prints the command.
8. **Adopt with CLAUDE.md conflict.** The merge session runs and exits before the bootstrap
   offer appears.
9. **Half-edited starter.** A starter with one added real line is curated and left untouched.
10. **Seeded lessons only.** `lessons-critical.md` exactly as shipped is a placeholder.

Validator, detection and error conditions:

11. A draft with a leftover slot line, an 11th fact, a 13th map entry, 36 non-comment lines,
    or a map entry naming a non-existent cold section is each reported.
12. Our own `codev/resources/arch-critical.md` passes the cap and map rules (no false positive).
13. The agent edits a curated file, a source file, or creates a commit: each is named, exit is
    non-zero, nothing is reverted.
14. User aborts the session with nothing written, or with only some files written: unwritten
    eligible files are reported; drafts that were written are kept; no success claimed.
15. No supported harness: nothing is launched; the prompt file path and manual instructions
    are printed.
16. One consult reviewer unavailable, and `consult` entirely unavailable: the pass completes
    and says which.

Non-functional:

17. Parity tests for the four skill copies stay green; both trees carry the change.
18. **Real-repo verification** (the issue's Verification section), owned by the builder in the
    review phase and recorded in the review document as an explicit gate item: run on a real
    pre-existing repository other than this one and confirm project-specific hot tier with no
    slots, cold archives matching the real system shape, the cap holds, and a re-run changes
    nothing. Not a CI test.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Classifier mistakes curated content for a placeholder and the pass overwrites it | Low | High | Subset-of-starter AND marker-present rule; doubt ⇒ curated; unit tests incl. half-edited starters; uncommitted output so git shows the diff |
| Agent writes outside the eligible files (curated docs, source, git state) | Low | High | Pre/post snapshot of files and git state; named report and non-zero exit; prompt lists exactly the writable files; no auto-revert |
| Agent copies secrets, internal endpoints or customer data into docs that get committed and injected everywhere | Medium | High | Bright-line rejection in the skill; reminder in the prompt; consult reviewers asked to check for it; human review before commit |
| Agent produces file enumerations, changelog framing, or invented lessons | Medium | Medium | Bootstrap mode states the rejections; validator for mechanical rules; 3-way consult; human review |
| Two agent sessions contend for the terminal during `adopt` | High if unaddressed | High | Await the merge session's exit before offering bootstrap (required) |
| Pass runs with a permission-bypass mode over an unfamiliar codebase | Medium | Medium | Explicit pre-launch statement and confirmation; detection report afterwards |
| Model cost on a large monorepo | Medium | Medium | Bounded git-log survey; explicit opt-in; never under `-y`; pre-launch notice |
| Unsupported harness | Medium | Low | Manual-prompt fallback |
| Thin git history yields a thin lessons file | Medium | Low | Accepted by design; no minimum lesson count |

## References

- Issue #1797 (this work)
- Spec 987: hot/cold two-tier governance docs, managed block, porch injection
- Issue #1012: cold-tier starter files on init/adopt/update
- Spec 591: agent harness abstraction (`HarnessProvider`)
- `update-arch-docs` skill (content contract, cap, displacement, map accuracy)
- MAINTAIN protocol (documentation sync step)
- `packages/codev/src/commands/adopt.ts`, `packages/codev/src/lib/scaffold.ts`,
  `packages/codev/src/lib/managed-block.ts`, `packages/codev/src/lib/gitignore.ts`
