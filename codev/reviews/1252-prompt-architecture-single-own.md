# Review 1252: Prompt Architecture — Single-Owner Rule for Instruction Content

## Summary

Issue #1252 asked for a single-owner rule across the ~45k-word prompt surface,
with an inventory before restructuring. Measurement reshaped the problem: the
largest duplication axis was one the issue never named — a 77-file shadow tree
under `codev/protocols|roles|consult-types` that outranked the installed
skeleton in the resolver and had drifted in 17 files, including the served
SPIR builder prompt (missing its entire `Verify Phase` section). The project
filed to fix prompt drift was itself spawned with a drifted prompt, and the
existing drift detector (#1210) had been reporting the problem to
`codev doctor`, unread, the whole time.

**Delivered, in eight phases:**

1. **Drift now fails CI** — `shadow-drift-gate.test.ts` wires the existing
   `auditProtocolDrift()` into a build-breaking check with a self-limiting,
   justification-required allowlist (now empty). Word + behavioural baselines
   captured before any content changed (M2, M6, M12a).
2. **77-row local-unique audit** (M11) with TS1–TS4 terminal states; four
   genuine local-unique findings escalated and ruled by the architect.
3. **17 drifted files reconciled** to the skeleton per ruling D1 (M3) — the
   headline repair restored `Multi-PR Mechanics`, `Verify Phase`, and the
   `"Entering verify phase."` string to served SPIR prompts.
4. **Shadow tree deleted** (M7–M10): the skeleton is the single owner; this
   repo now dogfoods exactly what it ships. Equivalence proven at three
   layers — resolver tier (path-asserted), assembly (nine protocols,
   byte-identical to pre-deletion snapshots via the real
   `buildPromptFromTemplate`), and the spawn wrapper (which had instructed
   builders to read a deleted role path — a live #1011-class bug, now a
   single-owner `builderPreamble()`). Vestigial `copyProtocols`/`copyRoles`
   removed. `skeleton-embed-sync.test.ts` byte-locks the source tree to the
   embedded build copy.
5. **Eight scar rules** (D3-ratified) registered in
   `codev/resources/scar-rules.yaml` with compressed canonical wordings,
   enforced line-exactly on every listed surface; deleting or rewording any
   fails CI (M5/T6). The `human-gates` rule was deliberately reframed to match
   the relay convention (the sin is acting without a human decision, not
   running `porch approve` after one is relayed).
6. **Machine-readable ownership map** (`prompt-ownership.yaml`, M1/M4) with a
   completeness contract: every normative line in the declared boundary needs
   a disposition; the catch-all cannot absorb cross-surface duplication; the
   human companion is validated against the YAML by a parity marker and
   per-class row assertions.
7. **Dedup by shared partials** (S1): ten instruction classes extracted to
   `codev-skeleton/partials/`, all `enforcement: automated`. Served prompts are
   per-agent delivery — a prose reference would have deleted content from
   agents' context, so the partial is the single *authored* owner while
   assembly expands full text into every served prompt, with a served-surface
   guard (presence from the include graph + per-artifact over-serve cap).
8. **Governance sync**: arch.md/arch-critical/lessons-learned updated to the
   post-1252 world (C6's "mirror both trees" retired — it had been factually
   false since Phase 4); ~20 stale references and two fetch-by-path
   instructions swept from the root docs; follow-ups filed (#1276 tiering,
   #1277 A/B eval).

**N1, honestly: 21,856 → 20,324 served always-on words = −7.0%** against an
aspirational ≥20% target. The decomposition: CLAUDE.md relocations delivered
−1,443; the drift *repair* added ~207 served words the prompts were always
supposed to have; D3's promotion of three user-global scar rules added ~120;
and the remaining surface is single-owned prose whose largest block
(protocol.md, 3,703 words) is protocol semantics — a spec Non-goal. The 20%
arithmetic assumed more of the surface was duplicated rules than measurement
bore out. Whether even −7% moved behaviour is the verify phase's question.

**Test surface added**: 8 new/extended suites (drift gate, shadow-tree audit,
removal equivalence, embed sync, scar rules, ownership map + served guard,
behaviour metrics, plus rework of 10 existing suites that read deleted paths).
Full suite at completion: **3,744 passed, 0 failures**. No flaky tests were
skipped.

## Architecture Updates

Applied during Phase 8 (this section records what and why):

- **`codev/resources/arch-critical.md`** — the "Two trees … mirror every
  framework change in BOTH" fact was rewritten (it had been false since the
  deletion): `codev-skeleton/` is the single owner of framework
  protocols/roles/consult-types, shadow drift fails CI, CLAUDE.md ≡ AGENTS.md
  folded into the same fact. The porch fact was split so the `status.yaml`
  scar canonical stands line-exact. The worktree fact now distinguishes
  architect-driven `afx cleanup` of *finished* builders from the scar-rule
  prohibition on bulldozing *live* ones. Caps held: 10 facts, 33 lines.
- **`codev/resources/arch.md`** — Repository Dual Nature rewritten
  (`codev/protocols/` holds local-only protocols exclusively; the deletion,
  its drift history, and the enforcing tests are told in place); a
  single-owner invariant added to Invariants & Constraints; the Glossary's
  Skeleton entry corrected from "copied to projects on init/adopt" to
  source-tree + build-time embed + tier-4 runtime fallback; deep references
  (Quick Start, protocol section headers, roles location, consultant
  resolution) repointed or annotated as the now-empty tier-2 slot.
- **New governance artifacts**: `scar-rules.yaml` (registry),
  `prompt-ownership.yaml` + `.md` (map + validated companion),
  `1252-shadow-tree-audit.md` (the 77-row record with rulings),
  `1252-behavior-baseline.md` / `1252-word-baseline.md` /
  `1252-word-after-phase7.md` (M12a/M6/N1 records).

## Lessons Learned Updates

Routed to `codev/resources/lessons-learned.md` (Critical) during Phase 8:

- **A detector that reports without failing is a detector nobody reads.**
  #1210 saw this drift for months; Spec 746's comments even described it
  ("PRE-EXISTING and not Phase 1's responsibility") before stepping around it.
  Detection was never the gap — consequence was. Corollaries recorded with it:
  frozen-file "pure addition" baselines are drift bombs (derive baselines
  instead); a grep classification of consumers is a hypothesis, not a proof
  (the deletion is the test); a metric must not reward moving text between
  files (measure the served artifact, not the authored one).

Additional lessons for this review (not promoted to the shared doc):

- **The corpus is live — a baseline can measure itself.** This project's own
  review verdicts contaminated its behavioural baseline (160 → 163) and its
  thread file contributed a scar-mining hit; self-exclusion had to be built
  in. The verify phase must keep 1252's artifacts excluded.
- **"The data exists" ≠ "the metric resolves."** B2 as originally specified
  ("rounds to unanimous approve") could never resolve: 0 of 48 terminal plan
  phases end unanimously — porch advances on rebuttal. Check the metric
  definition against the corpus, not just the sources.
- **Sweep-scope failures were the dominant review-iteration cause**: fixing
  the flagged instance instead of the class, grepping for a rule's wording
  instead of the act's, repointing a path while preserving the fetch
  instruction. The registry/line-exactness/served-guard machinery exists
  precisely to convert these recurring misses into impossible states.
- **Served surfaces dedup by include, not by reference.** Each agent sees only
  its own prompt; removing a rule from one deletes it from that agent's
  context. Single *authored* ownership with expansion at assembly is the
  correct model — and the measurement must count expanded words or the metric
  rewards the shuffle.

## Deviations from the Plan

- **Behavioural-metrics script location** — moved from root `scripts/` into
  `packages/codev/src/lib/` + thin CLI (root scripts can't resolve `js-yaml`
  in this workspace). Documented at Phase 1.
- **B2 metric redefinition and B5 determinism scope** — per delta review
  (rounds-per-phase instead of rounds-to-unanimity; T14 determinism over
  B1–B4 only).
- **Phase-2 escalation deadline** — the plan's original "zero pending at
  Phase 2 close" contradicted the spec's own sequencing; corrected to
  resolution-before-Phase-4, which is what happened (architect ruled E1/E2
  before deletion).
- **Reference model → include model for S1** — see Lessons; endorsed by
  reviewers as architecturally superior to the planned prose references.
- **T13(b) rescheduled to verify** (architect ruling): `afx spawn` has no
  branch selector, so a pre-merge probe would assemble the pre-change tree.
  Discovered constraint, not a skipped test; the pre-merge proxy is the nine
  byte-compared prompt snapshots; the architect runs the real probe
  post-merge + post-local-install.

## Flaky Tests

None skipped. The two full-suite failures encountered en route (unbuilt
`@cluesmith/codev-core`, missing `dist/` for shellper integration tests) were
build-state issues, verified and resolved rather than skipped.

## Verify Phase (pending, post-merge)

Per M12b and the T13(b) ruling, after merge + local-install:

1. Architect runs a disposable `afx spawn --task` probe from the main root;
   the assembled prompt must carry the Verify Phase section and all eight scar
   canonicals; prompt recorded here.
2. Re-run `packages/codev/scripts/measure-prompt-behavior.ts` over the next
   **N = 10** post-merge projects (**≥ 3 SPIR**); compare against
   `1252-behavior-baseline.md` (B1 51.88% is the load-bearing metric; soft
   trigger above ~64.9%); adjudicate B3 excerpts by hand; keep 1252's own
   artifacts excluded.
3. Rollback targets trims only (Phases 5/7), never repairs (Phases 1–4);
   under-powered windows are recorded as **inconclusive**, never as success.

## Systematic Observations

The 3-way review loop earned its cost on this project: across 8 phases and
~20 review rounds, Codex alone surfaced 12 accepted defects (several of which
would have shipped silently — the unmeasurable B2, the spawn wrapper's deleted
path, the appended-qualifier attack on scar enforcement, the double-served
rule). Every reviewer claim was verified against the tree before acting, and
two reviewer claims were rebutted with evidence and survived subsequent
rounds. The recurring failure mode on the builder side was under-sweeping;
the recurring value on the reviewer side was checking that enforcement
mechanisms actually bind, not just that artifacts exist.

## Follow-ups

- #1276 — multi-model fleet tiering (D4 deferral; ownership map is the base)
- #1277 — controlled A/B eval (M12c deferral; observational ceiling recorded)
- MAINTAIN candidates recorded in the ownership map: the three remaining
  `retained_restatements` classes (746-coordinated wordings), and porch gate
  events append-logging to make gate-rejection metrics minable (Appendix D §2).
