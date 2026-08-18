# Rebuttal — Spec 1470, Phase 4 (afx self-refresh command) iteration 1

**Verdicts**: Codex REQUEST_CHANGES (2 + 1 environment note) · Claude REQUEST_CHANGES (3 + 4 minor).

**All accepted.** Both reviewers independently found the same production-fatal defect, and Claude
found a second one. Between them: **the command would have refused every valid builder, and if it
had somehow run, it would have re-oriented that builder without telling it where in the protocol it
was.** Both are wrong *port bindings* — the exact class this phase's test file says in its own
docstring that it exists to catch.

---

## Both reviewers — the registry lookup was scoped to the wrong workspace

*(Codex #1; Claude #1, which probed it live)*

Verified before touching anything:

| Function | Returns, inside a builder worktree |
|---|---|
| `detectCurrentBuilderId()` (`send.ts:38`) | the **parent** — the prefix before `/.builders/` |
| `getConfig().workspaceRoot` → `findWorkspaceRoot()` (`utils/config.ts:76`) | the **worktree**, whenever it has its own `codev/` |

`findBuilderById` scopes its query by the second. Builder rows are keyed by the first (#1118). So
identity resolved against the parent while the row lookup asked the worktree: **no row, and "no
matching registry row" for every valid builder, on both `--begin` and execute.** Claude confirmed it
by probing live on this worktree.

**Why `afx refresh` doesn't hit it**: it runs from the main workspace root, where those two
directories are the same. I copied a sibling command's pattern into a different calling context —
same helper, different cwd, opposite result.

**Fixed**: `getBuilder(builderId, workspace)` scoped explicitly to `detectWorkspaceRoot()`, the same
resolver that derived the id. Identity and lookup now agree **by construction** rather than by two
call sites happening to derive the same value. Also refuses when the parent cannot be determined,
and names the workspace in the not-found message — the bare "no matching registry row" sent me
looking at the registry when the bug was in *which workspace was being asked*.

## Claude — `listDirs` was stubbed, silently stripping the porch context

*(Claude #2)*

I wrote `listDirs: () => []` in the real port binding; `reset.ts` binds a real `readdirSync`.
`readPorchContext` returns null the instant `listDirs` yields an empty array, so the re-orientation
lost project id, project name, phase, plan phase, spec/plan paths, and the `porch next` resume
notice.

**The damage is silent**, which is what makes it bad rather than merely wrong:
`assembleReorientation` requires the porch fields only `if (context.porch)`, so a null porch *skips*
the R3 completeness requirement instead of failing it. The frame assembles, looks complete, and
tells a refreshed builder nothing about where it is in the protocol — which is most of what this
feature exists to restore. A builder would come back knowing it is a builder and not which phase it
was in.

**Fixed**: bound for real, with a comment stating exactly what a stub costs, so the next person to
consider "it's only used for discovery" reads the consequence first.

## Both reviewers — no test exercised a real `.builders/<id>` layout

*(Codex #2; Claude #3)*

The sharpest point of the round, and the one that generalises. Both port-binding defects were
invisible to my tests for the same reason: **the tests mocked the things that resolve context, so
the resolution was never exercised.** Mocking `findBuilderById` hid the scope it derived internally;
mocking `resolveBuilderContext` whole meant the binding never ran. No number of additional
mock-based tests would have found either.

**Added** `spec-1470-real-worktree-context.test.ts`: real filesystem, real layout, no mocked
resolvers. **It failed three times before passing**, each on production scaffolding my mocks never
needed:

1. **Canonical builder ids are `builder-spir-1470`, not `spir-1470`.** `parseAgentName` matches only
   `builder-<protocol>-<id>`, and a weak porch claim is *refused outright* when the protocol cannot
   be corroborated — so a non-canonical id resolves **no** porch context. The worktree *directory*
   is `spir-1470`; the registry id is not. My command tests had been using the directory name as an
   id throughout.
2. `.builder-prompt.txt` must carry a `## Mode:` line — mode is persisted nowhere else.
3. `.builder-start.sh` must carry a recognisable launch command — re-orientation refuses to type
   into a terminal whose agent it cannot name.

Each failure was the test saying *your fixture is not the layout production sees*. That is precisely
the feedback the mocks were suppressing.

The file also carries a **regression test for the stub itself**: it asserts that a stubbed
`listDirs` nulls the porch context *and* that resolution still succeeds and looks well formed — so
the silence is pinned, not just the symptom.

## Codex — vitest could not start in the review sandbox *(no action)*

Third occurrence of the same environment limitation (`node_modules/.vite-temp` under a read-only
sandbox). Typechecking passed for them; the suite runs here. Noted so it is not mistaken for skipped
verification.

---

## Claude — minor items, all taken

- **`SelfRefreshOptions` numeric fields typed `number` while commander passes strings.** Now
  `string | number`. Declaring a type the runtime does not honour is a lie the compiler then helps
  enforce; `boundedInt` already parsed both.
- **`--challenge-max-age`'s floor was a bare `1`** while every sibling floor is a named constant.
  Now `MIN_ALLOWED_CHALLENGE_MAX_AGE_MS`, with a note that the permissive value is deliberate — any
  positive bound still expires a forgotten challenge, which is all that parameter is for.
- **`--dry-run` requires a live Tower.** Kept, with the reasoning written down: a rehearsal whose
  question is "would this refresh proceed?" must not report success in the one state most likely to
  stop the real run. Rehearsal fidelity, not an oversight.
- **"execute without `--begin`" has no command-level test**, as the plan's test plan specifies. It is
  covered in the core tests, where the refusal actually lives. Taken as a documentation point rather
  than duplicated: the command layer does not implement that refusal, so a command-level test would
  assert the core's behaviour through a mock — the exact pattern that produced this round's two
  defects. Recorded in the review artifact as a deliberate divergence from the plan's test plan.

---

## Net

2 production-fatal defects fixed, 1 new test file that exercises the real layout, 4 minor items
taken, 1 plan divergence documented. Tests: command 37 → 41, plus 6 new real-layout tests. Full
suite 5139 green.

**This is now the third and fourth production-fatal defect in this project that unit tests could not
structurally see** — after the nonce that could never exist when the command ran, and the boundary
guard left inert because the porch task text omitted `--boundary`. Every one was correct at every
layer I tested and dead in the real calling context.

The rule I am taking forward, and the architect has routed to `lessons-learned.md`:

> **Where a helper derives context internally, pass the context in instead — mocking the resolver
> hides the resolution.** Identity and lookup should agree *by construction*, not because two call
> sites happen to derive the same value.

And its companion, which the new test file demonstrates rather than asserts: **when a fixture keeps
failing on scaffolding you did not know was required, that is the test working.** Three consecutive
failures on canonical ids, mode detection and harness detection were three pieces of production
reality my mocks had been hiding.
