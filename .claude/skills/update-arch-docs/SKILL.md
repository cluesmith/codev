---
name: update-arch-docs
description: Audit, prune, and update the project's architecture documentation — `codev/resources/arch.md` and `codev/resources/lessons-learned.md`. Use this skill when running MAINTAIN's arch-doc step, or when asked to update / audit / prune `codev/resources/arch.md` or `codev/resources/lessons-learned.md`. The skill is opinionated about what NOT to include in these files (per-spec changelogs, exhaustive enumerations, aspirational state, duplicate meta-spec content) and ships two operating modes: diff-mode (apply a specific change) and audit-mode (propose cuts with reasons). It edits files directly via normal file-edit tooling and does not invoke destructive shell commands.
---

# update-arch-docs

This skill maintains two governance documents:

- `codev/resources/arch.md` — the project's architecture document.
- `codev/resources/lessons-learned.md` — durable engineering wisdom extracted from reviews.

It is invoked by the MAINTAIN protocol's documentation step, and ad-hoc whenever someone needs to update, audit, or prune either file. The skill is opinionated about *what does not belong* in these files. Use it whenever a doc change touches arch.md or lessons-learned.md, even if the change is just an addition.

## What this skill does NOT do

These are the patterns that have, in practice, caused arch.md and lessons-learned.md to grow without bound. Treat them as bright-line rejections during both audit-mode and diff-mode work.

### In arch.md

- **Per-file enumerations** that go stale the moment they're written. Document the *shape* of a directory and the handful of load-bearing files; do not list every file. `git ls-files` is authoritative; the doc is for orientation.
- **Per-spec changelog sections** ("Spec 0042 added X, Spec 0073 changed Y"). Architecture is current state, not history. The git log + the spec/review documents own the changelog framing.
- **Specs/plans tables** that mirror the contents of `codev/specs/` and `codev/plans/`. These are duplicative and rot quickly. Link to the directory; do not paginate it into the doc.
- **Aspirational state** ("we plan to…", "in the next phase we'll…"). That belongs in the relevant meta-spec or roadmap doc, not in the architecture body. arch.md describes what *is*, not what *might be*.
- **Date-stamped narrative** ("As of 2026-Q2, the system uses…"). Dates make the doc look fresh while making it harder to maintain. Use git log + commit dates for temporal context.
- **Duplication of meta-spec content**. If a subsystem has its own meta-spec under `codev/architecture/<domain>.md` or under `codev/specs/`, arch.md should carry a 1-paragraph summary plus a pointer — not a copy.
- **Retired-component graveyards**. When a component is removed, delete its section. `git log` retains history; an arch.md that describes things that no longer exist is misleading.

### In lessons-learned.md

- **Spec-narrow recipes** that only matter inside the originating feature ("In spec 0073 we found that the rate limiter needs X"). These belong in the spec's review document, not in lessons-learned.md. lessons-learned.md captures patterns that apply *across* specs.
- **Multi-paragraph entries**. If a lesson needs more than 1–3 sentences to land, it is either two lessons fused together or it is documentation that belongs elsewhere.
- **Duplicate adjacent entries**. Fold variations of the same lesson into one entry. Two entries that say the same thing are louder, not clearer.
- **Spec-numbered narrative entries** ("Lesson from #0468:…"). Link to the review if needed; the lesson itself should be stated as a general principle.

### In either file (process)

- **Destructive shell commands**. The skill must not invoke `rm -rf`, `git rm`, or destructive `sed` scripts. All edits go through the normal Edit tool. The MAINTAIN PR diff is the human-confirmation step; that's enough.

## arch.md vs. lessons-learned.md (two-doc framing)

Treat the two files as siblings with different purposes. When in doubt about which file a fact belongs in, route by purpose:

| Purpose | Goes in |
|---|---|
| Current system shape — services, transports, key mental models | `arch.md` |
| Mechanism for a unique subsystem | `arch.md` (subsystem section) — or its own meta-spec if the mechanism is large enough to warrant one, with arch.md keeping a 1-paragraph summary + pointer |
| Pointers ("see meta-spec X for details") | `arch.md` |
| A durable engineering pattern that applies across multiple specs | `lessons-learned.md` |
| A system-shape surprise verified-wrong in production ("looks like X but isn't") | `arch.md` § "Verified-Wrong Assumptions" — *not* lessons-learned.md, because it's a property of the system, not a general pattern |

The "system-shape surprise" routing is the one most often gotten wrong. If a future reader needs to know "the system *looks* like X but actually does Y", that is system shape and lives in arch.md. If they need to know "we learned that doing X is generally a bad idea", that is engineering wisdom and lives in lessons-learned.md.

## Sizing by purpose, not by line count

There is no line-count budget for either file. The right size for each section is determined by what the section needs to do. If a subsystem genuinely has unique mechanism that takes 80 lines to explain clearly, 80 lines is the right size. If a subsystem can be described in 5 lines and a pointer to a meta-spec, 5 lines is right.

What's *wrong* is bulk that comes from any of the patterns in "What this skill does NOT do" above. Strip those, and the file's size will land where it belongs.

When proposing a section, ask: "Could a future reader skip this section without losing anything load-bearing?" If yes, the section should not exist. The doc's purpose is orientation, not completeness.

## Mode: diff-mode (apply a specific change)

Use diff-mode when the request is specific: "add a section about the new caching layer," "update the Glossary entry for Tower," "remove the reference to the deleted dashboard-server."

In diff-mode:

1. Find the smallest section that needs to change.
2. Apply the change via the Edit tool.
3. If the change adds new content, run a quick sanity check against "What this skill does NOT do" before saving — make sure the new content is current state, not aspirational; not duplicative of a meta-spec; not a per-spec changelog entry.
4. Surface the resulting diff for review.

Diff-mode is fast. It is the right mode for ~80% of post-MAINTAIN documentation work.

## Mode: audit-mode (identify what to cut)

Use audit-mode when the request is general: "the doc feels stale," "MAINTAIN says it's time to prune," "review arch.md against the principles."

In audit-mode:

1. Read the file end-to-end.
2. For each section in arch.md, run through the per-section pruning checklist (from the MAINTAIN protocol):
   - Does it describe *current state*? If aspirational, the section moves to a meta-spec; the arch.md keeps a 1-paragraph summary + pointer (or nothing, if the meta-spec stands on its own).
   - Does it duplicate a meta-spec? If yes, replace with a 1-paragraph summary + pointer.
   - Is it a per-file enumeration that's gone stale? If yes, prune to the directory shape + a few key files.
   - Is it a changelog/narrative section ("Spec 0042 added X")? If yes, absorb the architecturally-relevant facts and remove the spec-numbered framing.
   - Is the component still alive? If retired, delete the section entirely.
3. For each entry in lessons-learned.md, run the per-entry checklist:
   - Is it cross-applicable beyond the spec that produced it? If no, remove (the lesson belongs in the spec's review).
   - Is it terse (1–3 sentences)? If multi-paragraph, split or compress.
   - Is the topic section the right one? If filed under "Architecture (continued)" or a spec-numbered section, move it to the right topical home.
   - Is it a duplicate of an adjacent entry? If yes, fold them.
4. **When in doubt, KEEP.** This rule comes from the MAINTAIN protocol and applies in audit-mode too. A confident cut is better than three speculative ones. Bias toward fewer, higher-confidence proposals with clear rationale; do not chase a maximum cut count.
5. Apply the cuts via the Edit tool — the skill does not produce a "candidate-cuts list and stop." The diff *is* the proposal. The MAINTAIN PR review is the human-confirmation step.
6. Surface a short reason alongside each cut in the run file (`codev/maintain/NNNN.md`) so PR reviewers can evaluate intent ("removed because: per-spec changelog framing"; "compressed because: duplicates the orchestrator meta-spec").

Audit-mode is slower than diff-mode and produces larger diffs. Reserve it for explicit audit invocations, not for routine doc updates.

## Output contract

The skill commits to the following:

- It edits `codev/resources/arch.md` and `codev/resources/lessons-learned.md` directly via the Edit tool.
- It does not invoke destructive shell commands (no `rm -rf`, no `git rm`, no destructive `sed`). File deletions happen only through Edit removing the relevant content; whole-file removal would be a structural change that is out of scope for this skill.
- In audit-mode, every removal is paired with a one-line reason in the MAINTAIN run file's `## Audit Findings` section. Rationale lives there so reviewers can evaluate intent without re-deriving it from the diff.
- The skill does not modify other files (specs, plans, reviews, source code). If a fact belongs somewhere else, the skill flags it; it does not move it.
- The skill does not edit live arch.md or lessons-learned.md content as a side effect of being read or invoked — only when the user/MAINTAIN protocol explicitly asks for an update or audit.
