# aspir-1286 — consult: configurable per-lane models and per-review-type lane selection

## Specify phase — started

Strict-mode ASPIR builder for issue #1286. No spec existed on spawn, so I'm drafting it.

### Codebase reconnaissance (before drafting)

Hardcoded model pins found:
- `packages/codev/src/commands/consult/index.ts:417-419` — codex lane: `model: 'gpt-5.4'`, `modelReasoningEffort: 'medium'`
- `packages/codev/src/commands/consult/index.ts:558` — claude lane: `model: 'claude-opus-4-6'`
- agy/`gemini` lane (`~line 846`) passes **no** `--model` → agy's default. Confirmed via `agy --help`:
  `--model  Model for the current CLI session` — so the gemini lane *can* take a configured id too.

Lane-selection resolution today:
- `porch/next.ts:63-90` `resolveConsultationModels()` — config `porch.consultation.models` > protocol `verify.models`,
  with special modes `none` / `parent`, validated against `VALID_MODELS`.
- `porch/index.ts:436-452` — a **second, inline, unvalidated copy** of the same precedence logic in `porch done`.
  Single-source-of-truth violation; any new precedence rule must consolidate these or they will drift.

Cost/metrics coupling:
- `CODEX_PRICING` (index.ts:386) is hardcoded to gpt-5.4 rates; Claude cost comes from the SDK (`total_cost_usd`).
- `consultation_metrics.model` stores the **lane name** ('codex'), not the model id — once ids are configurable
  you can no longer tell from metrics which model actually ran.

### Design position going into the spec

Fail-fast is required by the issue, but a **static allowlist of model ids is the wrong mechanism** — it recreates
exactly the rot this issue is about (and this repo's own lesson: never assert a model id doesn't exist from a
cached catalog). Position: validate *shape* and *lane names* strictly; let the provider be the authority on id
validity, and surface provider rejection loudly with a non-zero exit and no fallback to the hardcoded default.

Per-protocol scoping (`byProtocol`) rides along, per the issue's note about PIR's CMAP-2 cost invariant.

## Specify — iteration 1 review

gemini APPROVE · claude APPROVE · **codex REQUEST_CHANGES**. All three Codex issues were real; conceded
and fixed, plus Claude's four non-blocking comments. Rebuttals in
`codev/projects/1286-.../1286-specify-iter1-rebuttals.md`.

Codex's sharpest catch: the draft said unknown `byProtocol`/`modelsByType` keys are a hard error in
Desired State, then offered "loud warning" as a fallback in Open Questions — a real requirement
conflict a builder could have resolved either way. Fixed to hard-error unconditionally.

The one that needed actual design work was Codex's third: "validated against protocols/review types
discoverable through the four-tier resolver" was untestable hand-waving. The resolution is that the
two key spaces need **different set operations**, which wasn't obvious until forced to write it down:

- `byProtocol` keys = **union** of protocol names across all four tiers (any visible name is runnable)
- `modelsByType` keys = `verify.type` from the **resolved** file only, tier precedence applied
  (only the protocol.json that will actually execute defines which review types can occur)

So a locally-shadowed protocol contributes its *name* but not the shadowed skeleton copy's review
types. Scenario 16 tests that divergence in both directions.

Also resolved: `consult.pricing.codex` shape spelled out (all three per-1M rates required together —
a partial object errors, since defaulting one rate to a stale gpt-5.4 number reintroduces the exact
wrong-cost bug the key exists to fix); metrics `ALTER TABLE` migration promoted from "proposed" to
decided and in-scope; `consult.models.hermes` rejected (the `hermes chat -q` backend has no model
selector, so accepting the key would silently do nothing) while `hermes` stays valid as a lane name
in `porch.consultation.*`.

## Specify — iterations 2 and 3, and the force-advance

**iter 2**: gemini/claude APPROVE, codex REQUEST_CHANGES. Two more real catches, both conceded:
- I had *introduced* a contradiction in iter 1 — Desired State said `consult.reasoningEffort` accepts
  `{claude,codex,gemini}` while Open Questions said `{codex}` only. Now split into its own paragraph
  with the two key spaces stated as deliberately divergent.
- "reject shell metacharacters" was untestable and could reject provider-valid ids — reintroducing
  staleness one layer down. Replaced with `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`.

Claude's iter-2 comment, framed as a plan concern, turned out to be a **hole in the spec's central
contract** — verified at `consult/index.ts:938`: every non-zero agy exit becomes a `VERDICT: COMMENT`
non-blocking skip, so a typo'd gemini model id would have silently skipped and let porch advance.
Fixed in the spec by splitting failures by *cause* (environment → skip, as today; configured-model →
hard fail), with a guaranteed floor that needs no fragile stderr parsing.

**iter 3**: gemini/claude APPROVE, codex REQUEST_CHANGES — `consult.reasoningEffort.codex` had a
pinned key space but an undefined *value* space. Resolved to the closed enum read from the installed
SDK (`@openai/codex-sdk/dist/index.d.ts:237` → `minimal|low|medium|high|xhigh`), validated locally.
The obvious objection — "you just added the allowlist you spent three paragraphs arguing against" —
is answered in the spec with a table: an open provider-owned catalog is unknowable to Codev; a closed
union from a *pinned dependency* is a compile-time fact. Binding requirement: the set must derive
from the SDK's exported type so an upgrade breaks the build instead of drifting silently.

### ⚠️ The spec was FORCE-ADVANCED, not approved

`status.yaml` records `force_advanced: {phase: specify, iteration: 3, max_iterations: 3}`. Codex
never returned APPROVE on the spec. Its iter-3 issue *was* fixed and committed — but after the
review, so **that fix has never been reviewed by anyone**. Gemini and Claude approved iterations
1–3; Codex requested changes in all three, each time on a genuinely different and valid defect.

Read honestly: Codex found a real defect on every single pass, which is weak evidence that a fourth
pass would have found a fourth. The spec is not "approved"; it is "out of review budget." Flagged to
the architect. Proceeding to Plan per ASPIR (no spec-approval gate), with this caveat on record for
the PR gate.

## Architect-required codex recheck (the 4th pass) — and a lesson about it

Architect endorsed the spec against issue #1286 item by item, with one required step: a codex-only
re-review of the current spec before planning. Also recorded (no spec change): defaults stay
unchanged; this repo opts into claude-opus-5/gpt-5.6 via its own `.codev/config.json` **after merge**,
architect-owned, explicitly not in this PR.

**Trap avoided**: porch had already advanced to `plan`, so a `--project-id` consult would have
auto-persisted to `1286-plan-iter1-codex.txt` and masqueraded as a plan-phase review — potentially
letting porch count a spec review as plan verification. Passing an explicit `--output` outside the
project dir short-circuits auto-persist entirely (`index.ts:2081`: `if (!outputPath && …)`). Verified
afterward that no `1286-plan-iter1-*` file exists.

**Result: REQUEST_CHANGES, but 2 of 4 findings were factually false** — Codex claimed the spec file
"contains an entire `## Plan` section after `## Notes`" and therefore breaks the template. Verified
against disk: the spec has exactly the 20 canonical headings, Metadata → Notes, and no `Plan`
heading. It also cited `satisfies readonly ModelReasoningEffort[]` and specific module names as spec
content — those strings appear **only** in the plan file.

Cause: I had just written `codev/plans/1286-*.md`, and a `--type spec` review bundles project
artifacts, so Codex read spec+plan concatenated as a single file. The three earlier iterations — run
when no plan file existed — never raised this. Worth knowing generally: **a spec-type consult run
after the plan exists will report plan content as spec content.**

One finding was real and fixed: `ALTER TABLE ADD COLUMN` / `PRAGMA table_info` were mechanism sitting
in the spec (Desired State + Open Questions). Trimmed to a requirement ("idempotent, non-destructive
against a populated DB; mechanism is a plan concern"); the plan carries the mechanism.

Deliberately **not** changed: the model-id regex. Codex's iteration-3 review *demanded* an exact
syntactic rule; removing it now as "too implementation-detailed" would undo a fix the same reviewer
required two rounds earlier. It is the acceptance contract for what config is legal, which is
squarely WHAT.

Per the architect's standing instruction (address what's real, then proceed without a round-trip),
moving on to the Plan phase.

## Incoming: issue #1288 changes shipped defaults (architect FYI, 2026-07-29)

`claude` lane default → `claude-opus-5`; `codex` lane default → **`gpt-5.6-sol`** (live-probed; plain
`gpt-5.6` is REJECTED under ChatGPT-account auth — the `-sol` suffix is load-bearing). Spec's
out-of-scope call on defaults stands; #1288 is a separate project.

**Required before implement**: rebase onto main and check whether #1288 landed.

**The real issue is not the rebase — it's that my default-preservation criterion names literal ids**
(`claude-opus-4-6`, `gpt-5.4` @ medium), so it silently becomes wrong if #1288 merges first and
nobody remembers to edit it. Making it structurally rebase-proof instead, in two layers:

- **Layer A (behavioral, rebase-proof)**: zero-config → the SDK receives *the module's default
  constant*. Guards the config plumbing; survives #1288 with no edit.
- **Layer B (one deliberate pin)**: a single test asserting those constants equal the ids the repo
  ships at that commit. One-line update when #1288 lands; fails loudly on accidental drift.

Layer A alone is tautological (it would pass even if a default constant were changed by mistake),
which is exactly why B exists as a separate, intentionally-edited line.

Also: `gpt-5.6-sol` matches the spec's id regex (hyphens permitted) — adding it as an explicit
accept-vector, since a real id with a load-bearing suffix is a good check that the rule isn't too tight.

Deferred until the in-flight plan consultations finish — editing the plan mid-review would make the
three reviewers' feedback inconsistent with each other.

## Implement — phase_1 done, and the behaviour-baseline landmine

Phase 1 shipped: `consult-lanes.ts` (validators + resolvers), `CodevConfig` extensions, cross-tier
`listProtocolNames`/`canonicalProtocolName`/`listReviewTypes` in `skeleton.ts`, `findConfigSource`.
65 new tests. Validation is invoked from `loadConfig()` per the plan, matching the existing
`validateCustomHarnessConfig` precedent.

Verified the `satisfies readonly ModelReasoningEffort[]` binding is genuinely load-bearing rather
than decorative: temporarily adding `'bogus-effort'` produces
`TS2322: Type '"bogus-effort"' is not assignable to type 'ModelReasoningEffort'`. That check is the
difference between the spec's requirement and a comment claiming it.

### The landmine, and getting the disposition wrong then right

`prompt-behavior-metrics.test.ts` pins `b1_totalVerdicts=160` but measures LIVE repo history
(`codev/projects/*/status.yaml`), so any project running consultations here perturbs it. Measured
163 with 1286 included, exactly 160 excluded — proving repo content, not a code defect. The test's
own comment records project 1252 hitting the identical 160→163 and fixing it by self-exclusion.

I flagged it to the architect rather than bumping the number — correct. But when it then blocked
`porch done`, I followed 1252's precedent and excluded the in-flight project. **The architect ruled
that wrong** and it is now reverted: a per-PR exclusion/bump treadmill quietly destroys the
baseline's meaning. Root cause is measuring live history against a frozen number; the real fix is
freezing the *sample set*, shipped as PR #1290 (`MeasureOptions.includeProjects`, 18 pinned
projects).

Lesson worth keeping: "follow the existing precedent in the file" was not sufficient here — the
precedent itself was the unfixed bug, and copying it would have propagated it one project further.
Rebase onto main once #1290 merges; until then `porch done` will fail this one test, and the answer
is to wait for the rebase, not to touch the baseline again.

Also confirmed environmental (architect agreed): `session-manager.test.ts`'s 8 failures need a built
`dist/terminal/shellper-main.js` — they pass after `pnpm build`.

## phase_1 review, and the current hold

gemini APPROVE · claude APPROVE · **codex REQUEST_CHANGES** — and Codex was right twice.

The find that matters: `byProtocol.<name>.modelsByType: null` reached `Object.entries()` and raised
a bare `TypeError: Cannot convert undefined or null to object` instead of a keyed config error.
`typeof null === 'object'`, and I had written the `=== null` clause correctly one level up but
omitted it in the nested copy. Reproduced before fixing. Note what missed it: two other reviewers,
65 passing tests, and a clean typecheck — it took an adversarial read of the validator itself.
Response was to fix the family, not the line: a table-driven suite asserting every null position
raises a keyed `Error` and specifically not a `TypeError`.

Second find, also fair: I claimed four-tier discovery and tested two. The untested ones (cache,
skeleton) are exactly the tiers a fresh adopter relies on, since neither `.codev/protocols/` nor
`codev/protocols/` need exist in a fresh install. Added both plus cross-tier shadowing. 65 → 75.

**Held at phase_1 iter2**: `porch done`'s tests check fails on exactly one test
(1 failed | 3867 passed) — the baseline landmine. Architect ruled bump/exclude/skip all out, and
#1290 (freezes the sample set via `MeasureOptions.includeProjects`) is 5/6 green, blocked only on a
known pre-existing `send-integration.e2e` "Hook timed out" flake seen on #1283 and four other
branches. Waiting for it to merge, then rebase → `porch done`. Not starting phase_2: porch says not
to, and it would blur the phase-review boundary.

On the rebase, also re-check #1288 (defaults → `claude-opus-5` / `gpt-5.6-sol`). The two-layer test
structure means that change costs one deliberate line, not a scatter of edits.

## Hold update — #1290 is green, waiting on review

Re-checked the blocker: PR #1290 (`fix/1252-baseline-frozen-sample`) now shows **6/6 checks pass** —
the `send-integration.e2e` "Hook timed out" flake that held it at 5/6 has cleared on a re-run, which
is itself confirmation the failure was the known flake and not the change. Its `mergeStateStatus` is
`BLOCKED` for exactly one reason now: `REVIEW_REQUIRED`. That is the architect's call, not mine, so
I've notified rather than acted.

`origin/main` is still at 54118ef0 (merge of #1283), so nothing has landed that would unblock me by
another route. Position unchanged and deliberate: not bumping the baseline, not excluding 1286, not
skipping the test, not starting phase_2. Resume sequence on merge is fixed — rebase onto main →
`porch done 1286` → phase_2 — with the #1288 defaults re-check (`claude-opus-5` / `gpt-5.6-sol`)
folded into the same pass.

## Unblocked — rebase onto main, and three things the rebase taught

Architect merged #1290 (admin-authorized). Rebased; phase_1 checks are now **green**
(build 4.9s ✓, tests 27.6s ✓). The baseline test that held this phase for a day passes 9/9 against
#1290's frozen sample set, and my copy of `prompt-behavior-metrics.test.ts` is byte-identical to
main — the "don't touch the baseline" ruling held all the way through.

Three non-obvious things, each worth the next builder's attention:

**1. A commit and its own revert both conflict on rebase.** `8ca1ef48` (exclude in-flight projects)
and `608baf1a` (its revert) each collided with #1290's rewrite of the same file. Skipping both is
correct *only if* they truly cancel, so I proved it first rather than assuming the word "Revert" in
a subject line: `git diff 8ca1ef48~1 608baf1a` touched only an unrelated `status.yaml` and left the
test file untouched. Pre-rebase tip recorded (`e9405d9e`) before skipping anything.

**2. `origin/main` moved *during* the rebase, and the symptom was alarming and wrong.** #1287
(bugfix-1279 closeout) landed between my fetch and my verification, so `git diff origin/main --stat`
showed my branch deleting 41 lines from *another builder's* thread file. What proved it innocent:
`git log origin/main..HEAD -- <file>` returned no commit, and `git merge-base --is-ancestor` said
main was not an ancestor of HEAD — i.e. stale ref, not a destructive edit. Re-fetch, rebase again,
`--is-ancestor` passes. Lesson: when a diff accuses you of deleting someone else's work, check
ancestry before you check your own conscience.

**3. Rebase then makes `porch done` fail at a step that has nothing to do with your phase.**
Checks passed, then `writeStateAndCommit failed: git push -u origin HEAD (non-fast-forward)` —
rewritten history vs. the stale remote branch. Before force-pushing I verified the remote held
nothing unique: every "lost" commit was an old SHA of my own work, its `status.yaml` was strictly
older (`build_complete: false`, and bugfix-1279 at `pr` vs main's `verified`), and no PR was open on
the branch. `--force-with-lease`, not `--force`. Note the ordering trap: the failed run had already
committed `build_complete: true` locally but aborted the transition, so `porch done` needed a second
run — the first one's partial success is invisible unless you read the log.

Also re-checked #1288 per the architect: still an open issue with **no PR**, so nothing to fold in.
Defaults stay as shipped; the two-layer test structure keeps that a one-line change later. Will
re-check main at each subsequent phase.

Now running the phase_1 iter2 3-way review (gemini/codex/claude, `--type impl`).

## phase_1 APPROVED (iter2) — and what chasing a "non-blocking nit" turned up

gemini APPROVE · codex APPROVE · claude APPROVE. Codex ran the phase_1 unit suite itself before
verdicting and returned `KEY_ISSUES: None`; claude gave HIGH confidence and independently confirmed
both iter1 findings were genuinely fixed (not just claimed fixed). Porch advanced to phase_2.

Claude attached three non-blocking observations. I verified each against the file rather than
trusting the summary — and the cheapest-looking one was the one that mattered:

1. **`normalizeLaneList`'s `| null` return type is dead** — true, every path returns an object, so
   `if (normalized)` could never be false. Removed both.
2. **`VALID_LANE_NAMES` duplicated in `porch/next.ts`** — true, and explicitly phase_5's job. Left it.
3. **`validateLaneList` accepts a bare string** — intended; mirrors the existing string-or-array
   shape of `porch.consultation.models`.

Chasing (1) exposed a gap **all three lanes missed**: `[]` validated and resolved to
`{models: [], mode: 'normal'}` — zero lanes. That is an undocumented second spelling of the spec's
one explicit skip sentinel, `"none"`. Rejected it per fail-fast with an error that names `"none"`,
and pinned it at **all four** precedence levels rather than just the top — the same "must fire in
every nested copy" family as the null guard Codex caught, where a single top-level test would have
passed while three nested paths stayed broken. 75 → 80 tests, full suite 3873 passed / 0 failed.

Recorded honestly: this is a behavior change made *after* unanimous approval, on my own judgment, so
it has not been reviewed by anyone. I chose to ship it because tightening is the reversible direction
(loosening later is safe; the reverse breaks live configs) and because leaving a known ambiguity to
calcify across five more phases is worse. Disclosed to the architect for scrutiny at the PR gate
rather than allowed to pass as "reviewed."

Two mechanical notes for whoever rebases next: `porch done` partially succeeds — the run that died
on the push had **already committed `build_complete: true`**, so a second `porch done` was needed and
the first run's progress is invisible unless you read its log. And `porch` resolves the project from
cwd: running it from `packages/codev` (left over from a test run) gives a flat
`Error: Project 1286 not found.` that looks like state corruption and isn't.

## The `[]` ruling — asymmetric on purpose, and why that's defensible

Architect caught what I'd missed: EXPERIMENT and SPIKE **ship** `defaults.consultation.models: []`
(paired with `enabled: false`) in both trees — four files — meaning "this protocol runs no
consultations." If my rejection reached protocol level, every EXPERIMENT/SPIKE project would break
the day this merges.

Verified the boundary instead of assuming it. Two facts settle it:
- `validateConsultationConfig` has **exactly one** production caller: `config.ts:326`, on
  `merged.porch?.consultation` — user config.
- Protocol models arrive at `resolveLaneComposition` as the `protocolModels` argument and never
  touch the validator; with no config, `fallback = { models: protocolModels, mode: 'normal' }`
  returns them unchanged.

So the asymmetry already existed in my implementation. **Keeping it, deliberately**: protocol.json is
a shipped artifact with established semantics, config is user input where an ambiguous second
spelling is a usability bug. Now documented at the rejection site with an explicit warning that
routing protocol models through the validator breaks those two protocols.

Test pins both halves — `[]` rejected as config, `[]` honoured from a protocol — and reads the real
shipped `experiment`/`spike` protocol.json rather than a fixture. It carries a **premise guard**:
`expect(declared).toEqual([])` before the resolve assertion, so if a protocol ever stops shipping
`[]` the test fails loudly instead of quietly passing while proving nothing. That mattered here: the
test has an `existsSync` early-return for bare-source checkouts, which is exactly the shape that
passes vacuously — so I confirmed out-of-band that the skeleton path resolves
(`packages/codev/skeleton/protocols`) and both files exist with `[]`. A green test whose assertions
never ran is worse than no test.

82 tests, full suite 3875 passed / 0 failed, tsc clean. Per the architect this rides into the
**phase_2 CMAP explicitly** rather than passing as reviewed — it will be called out in that round's
context. Now starting phase_2 proper (consult lane model wiring).

## phase_2 — the flag that parsed perfectly and did nothing

Wired both SDK lanes to `consult.models.<lane>`, codex's `modelReasoningEffort`, and a
`--model-id` per-invocation override. Shipped defaults now live in named constants so zero-config
behavior is preserved by construction rather than by a new default written elsewhere.

**The finding that justifies the manual test line in the plan.** I had the option registered in
`cli.ts`, the field on `ConsultOptions`, both runners threaded, and 20 green unit tests asserting the
configured id reached each SDK. Every one of those was true. The flag still did nothing: `cli.ts`'s
action builds an **explicit** `ConsultOptions` object, so `modelId` was silently dropped on the way
through. Registering an option is not wiring it.

The near-miss is the interesting part. My first end-to-end run with
`--model-id definitely-not-a-real-model-xyz` printed a cheerful `OK` and wrote a review file. The
plan had *already anticipated* a risk that reads exactly like that symptom — "an SDK swallows a bad
id and silently substitutes, defeating fail-fast" — so the tempting move was to file this under a
known, documented, already-mitigated risk and move on. Probing the SDK directly instead killed that
theory: codex rejects unknown ids with a 400 `invalid_request_error`. The id had never arrived. A
pre-existing hypothesis that fits the symptom is the most expensive kind of wrong.

Verified after the fix against a genuine provider rejection: verbatim 400 text, the key
(`consult.models.codex`), the exact config file that supplied it, exit 1, **no review file**. Flag
path names `--model-id` instead; a default-model failure stays unannotated, since there is no user
config to correct.

Mutation-tested both guards rather than trusting green: re-hardcoding codex's model fails 2 unit
tests; removing the `cli.ts` forwarding fails exactly the new regression test. The guard costs no
network call — a syntax-invalid `--model-id` is rejected by the resolver before any provider call.

**Caveat on that guard's reach**: it lives in `consult.e2e.test.ts`, which the default vitest config
excludes via `**/*.e2e.test.ts`. It runs in the *CLI Integration Tests* CI job, so it protects the
merge, but it will NOT fire in porch's local `tests` check during phase iterations.

Also: never run `npm run build` while the suite is running here. Its `copy-skeleton` step is
`rm -rf skeleton && cp -r`, and skeleton-reading tests fail mid-flight. I reported "2 failed" from
exactly that self-inflicted race before re-running clean at 3895 passed / 0 failed.

Final: tsc 0 · unit 3895 passed / 0 failed · CLI integration 93 passed / 0 failed.

## Extracting the cause instead of duplicating the guard

Architect ruled on the coverage gap I flagged: don't mirror the e2e test somewhere porch sees —
extract the *cause*. The failure class was "cli.ts builds an explicit `ConsultOptions` object and
silently drops a field", so registration and mapping now live together in
`commands/consult/cli-options.ts`, and a unit test compares them. Not invasive after all (one module,
two call sites), so I took the unit-test path rather than accepting the offered CI-only fallback.

The test deliberately **does not restate the flag list** — it reads flags back out of commander via
`attributeName()`. A hand-written list would drift exactly the way the mapping did; the guard has to
derive from the thing it's checking. Four properties: registered-but-unforwarded, mapped-but-
unregistered (catches a one-sided rename), a distinct sentinel per key so a mapping that reads the
*wrong* source key fails too, and a self-check on the introspection so it can't pass vacuously
against an empty list — the same trap as the `existsSync` early-return in phase_1. Mutation-verified:
deleting the `modelId` line fails naming `modelId`.

Fixed a defect I introduced this phase: reusing the config validator for a flag produced
`Invalid model id "has spaces" for --model-id in Codev config`, which sends someone to a config file
to fix what they typed on the command line. The clause is now suppressed for flag-shaped keys.

**The build-vs-test race bit me a second time**, and it's worth the embarrassment of recording.
Having already noted "never run `npm run build` while the suite runs", I launched the next
verification job — which *starts* with a build — while the previous job's CLI integration tests were
still spawning `dist/cli.js`. `rm -rf skeleton` plus a dist rewrite mid-run produced 9 failures
across 2 files that looked exactly like a refactor regression. Clean re-run: 93 passed / 0 failed.
Knowing a hazard and sequencing around it are different skills. The rule that actually works is
narrower than the one I wrote: **only one build-or-test job in flight at a time, full stop** — not
"don't build during tests", because a job that builds counts as a build.

Final: tsc 0 · unit 3901 passed / 0 failed · CLI integration 93 passed / 0 failed.

## phase_2 iter1 review — codex 3-for-3

gemini APPROVE (HIGH) · claude APPROVE (HIGH) · **codex REQUEST_CHANGES (HIGH)**. Codex has now
found the decisive defect in three consecutive review rounds on this project, and this one was the
sharpest: `--model-id` was documented as applying to "whichever lane `-m` selected", but only the
claude and codex branches read it — so `consult -m hermes --model-id foo` parsed, appeared in
`--help`, and did nothing.

That is the *same failure class this phase existed to eliminate*, reintroduced by my own flag
description within the same phase that fixed it. And the detail that stings: `MODEL_CONFIGURABLE_LANES`
is `['claude','codex','gemini']`, and phase_1 already carries a bespoke error explaining why hermes
cannot take a model id — **I wrote that explanation, then wrote help text contradicting it.** Fixing
the mechanism does not fix the documentation that promises more than the mechanism does; those are two
artifacts and they drift independently.

Fix placement mattered more than the fix. `assertLaneAcceptsModelOverride()` is called once in
`runConsultation` **before dispatch**, not per-branch: a per-branch check would leave exactly the same
hole open for the next lane that doesn't read the override. Structural, not local.

Deliberate call on gemini, recorded so it is a tracked promise rather than an intention: gemini is
configurable by spec but its passthrough is phase_3's scope, so `-m gemini --model-id` is inert right
now. I did not add a "not yet wired" error, because nothing ships until the PR carries all six phases
and a temporary error on a documented-supported combination would be worse. A test asserts all three
configurable lanes accept the override, so **phase_3 cannot quietly narrow the contract** without
failing a test.

Also worth noting on review logistics: porch's iter1 command carried no `--context`, so to honour the
architect's "air the `[]` asymmetry explicitly" I wrote my own note file (named
`-architect-note.md`, deliberately not porch's `-context.md` convention, to avoid colliding with
porch's bookkeeping) and passed it via `--context` to all three lanes. Asking pointed questions paid
off: gemini independently traced the validator's call graph and confirmed "no third paths reach
protocol-supplied models", which was the one claim resting only on my own single-caller grep. All
three lanes endorsed the asymmetry and found no vacuous-pass path in the forwarding test. gemini also
answered the docs question — `"none"` as the skip sentinel belongs in phase_6 user docs, not phase_2.
**Carry that into phase_6.**

Verified end-to-end, not just unit-tested: hermes+flag exits 1 naming the accepting lanes; hermes
without the flag is unchanged; gemini is not blocked. tsc 0 · unit 3905 passed / 0 failed ·
CLI integration 93 passed / 0 failed.

## phase_3 — the split, and why stderr mattered more than the exit code

Implemented `--model` passthrough plus the environment-vs-configuration failure split. The plan
called this "the phase with the quiet failure mode" and it was right to state the rule as an
invariant: **a skip may only be reached for an environment cause.**

Deliberately narrow. Only a non-zero exit hard-fails, and only when a model is configured. Auth,
timeout, non-response and empty output stay skips *even when configured*, because a degraded agy
(#1032/#1033) must never wedge a phase. Mutation-verified rather than asserted: widening the
condition to `if (code !== 0)` fails the unconfigured-lane test — which is precisely the risk the
plan named ("breaking the degraded-lane property for unconfigured workspaces").

**The stderr detail turned out to be the substance of the phase.** stderr was already piped and
scanned for auth markers, then thrown away — only stdout accumulated. So a hard failure would have
reported `agy exited with code 1` and nothing else, satisfying the control flow while failing the
diagnostic requirement completely. Retaining a bounded 2000-char tail changes the character of the
error: against real agy the captured text **lists the valid model ids**, so the failure tells you
what to use instead of merely that you were wrong. Bounded because it lands in an error message.

Verified against the real `agy`, not just the fake subprocess — this is the plan's manual test, and
it is not observable from a unit test:

| case | exit | review file |
|---|---|---|
| configured + bogus id | 1 | none → porch cannot advance |
| unconfigured | 0 | written → non-blocking preserved |

Also closed the gemini `--model-id` gap I recorded as a tracked promise in phase_2.
`resolveOptionalLaneModelChoice` returns `null` when unconfigured, so the flag is *omitted* rather
than defaulted — gemini has no default to fall back to, agy picks its own.

Kept the argv-order guard the plan flagged: `--model` must precede `--print`, since agy parses
`--print` as string-valued and its value must immediately follow. A test asserts the ordering, because
getting it wrong would silently feed `--model` to `--print` as the prompt.

14 new tests · tsc 0 · unit 3919 passed / 0 failed · CLI integration 93 passed / 0 failed.
