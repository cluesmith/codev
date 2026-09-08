# bugfix-1641 — `consult -m claude` fails with "Prompt is too long"

Issue: #1641. Protocol: BUGFIX (strict). Branch: `builder/bugfix-1641`.
Base commit: `c4ad613fcda59ad4c996eb59c66794a80e57e7c2`.

## Investigate

Reproduced the failure mechanism from evidence rather than by burning subscription
quota on another 5-minute review.

**What the five attempts actually show** (corrected after architect review — see below):
four of the five ended in `Prompt is too long`; the third builder-side attempt hit a
separate subscription usage limit and is not evidence of this bug. The two saved failing
sessions show 29 and 51 tool calls with last-successful inputs of 174,521 and 175,930
tokens before the error. That is accumulated review-context exhaustion surfacing as
`Prompt is too long` — it does not establish where the request was refused, nor that
every changed file was read in full. It is not an oversized opening prompt: the opening
prompt for `--protocol pir --type impl --project-id 1481` inlines spec 2.5K + plan 34K,
roughly 10K tokens.

Root cause, verified against the actual source and the bundled runtime:

1. `packages/codev/src/commands/consult/index.ts:419` —
   `DEFAULT_CLAUDE_MODEL = 'claude-opus-5'` (a bare id, no context suffix).
2. The Agent SDK's bundled runtime derives the context budget from the model id. Its
   window function `jk(q,K)` has four branches — a `DISABLE_COMPACT` +
   `CLAUDE_CODE_MAX_CONTEXT_TOKENS` env override, `ZG(q)` (the `[1m]` suffix),
   `K?.includes(jo)&&UT1(q)` (beta header), and `TV8(q)` (gated, requires
   `sonnet-4-6`) — before falling through to `qh1 = 200000`. So there is **no** universal
   "1M with a suffix, 200K otherwise" rule. The scoped, verified fact is narrower:
   under SDK **0.2.105** (this repo's lockfile) and **0.2.141** (the installed build),
   bare `claude-opus-5` budgets **200,000** and `claude-opus-5[1m]` budgets **1,000,000**.
3. `runClaudeConsultation` gives the lane `allowedTools: ['Read','Glob','Grep']`
   and `maxTurns: 200`, so a review of a 41-file PR accumulates context until the 200K
   budget is exhausted.
4. `packages/codev/src/lib/consult-lanes.ts:77` —
   `MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/` rejects `[` and `]`,
   so **no user could work around it** via `consult.models.claude` or
   `--model-id claude-opus-5[1m]`. That is why the failure was unrecoverable
   across the attempts rather than merely inconvenient.

Other lanes against the same target: **codex** completed (239.4s, `REQUEST_CHANGES`).
**gemini** did *not* review — I opened its 358-byte artifact and it is a non-blocking
skip notice (`Gemini lane skipped — agy exited with code 1`), so it is no evidence the
target was reviewable either.

Scope: 8 files, +68/−25. Comfortably inside BUGFIX's ~300 LOC ceiling.

## Seeded fix

Architect `main` instructed (2026-09-08T23:32Z) that a tested fix already exists
and must be imported rather than rewritten:
`/tmp/codev-1641-builder-handoff-bfow5fso/fix.patch`.

Verified before accepting it:
- `sha256 = 7c11c00c…33b21` matches `manifest.json`.
- `git apply --check` clean against my HEAD.
- Its base commit matches my branch base.
- Re-derived the new `MODEL_ID_RE` behavior in node against all 15 cases the
  new tests assert — accepted/rejected sets match exactly, including the
  200-char total-length boundary (196+`[1m]` ok, 197+`[1m]` rejected) and
  `opus\n` (JS `$` has no Perl trailing-newline exemption, so it is rejected).


## Fix

Imported the seeded patch in two steps so the regression was demonstrated, not asserted:

1. Applied **test files only** (`git apply --include=…` × 4). Baseline run:
   **13 failed / 345 passed** — `expected 'claude-opus-5' to be 'claude-opus-5[1m]'`
   and `Invalid model id "claude-opus-5[1m]"` from `validateModelId`.
2. Applied the **production + docs** files. Same command: **358 passed / 358**.

Verification:
- All 8 files hash-match `manifest.json` after apply (patch sha256 also matched).
- `pnpm build` — passed. The 2 residual failures in the first post-fix run were
  `resolveCodevFile` skeleton-fallback tests that need `copy-skeleton`; they
  cleared once the build ran. Unrelated to this change.
- Full `@cluesmith/codev` suite: **5754 passed, 48 skipped, 0 failed** (288 files).
- `git diff --check` clean; `codev/` and `codev-skeleton/` consult.md byte-identical.
- Only production consumer of `MODEL_ID_RE` is `validateModelId` — blast radius contained.

Fix is 8 files, +68/−25. Well inside BUGFIX's ~300 LOC ceiling.

## PR

PR **#1657** — https://github.com/cluesmith/codev/pull/1657 (branch `builder/bugfix-1641`).
Recorded with `porch done bugfix-1641 --pr 1657 --branch builder/bugfix-1641`.

Porch's own phase checks passed: build 13.2s, tests 28.6s.

CMAP note: the first dispatch of all three lanes failed identically with
`Multiple projects found: …` — from a builder worktree `consult` still needs
`--project-id` when the repo carries many project directories. Re-dispatched as
`consult -m <lane> --protocol bugfix --type pr --project-id bugfix-1641 --output …`.
Not a finding against this PR; noting it because the porch PR-phase prompt's
example omits the flag.

### CMAP verdicts (PR #1657)

- **gemini** — `APPROVE`, confidence HIGH, KEY_ISSUES: None (49.1s). Independently
  re-derived the regex against every boundary case and reached the same results I did.
  Noted that `/i` is a no-op on the character class (both cases already listed) and
  affects only the `\[1m\]` suffix — which is the intent. Not a defect.
- **codex** — `APPROVE`, confidence HIGH, KEY_ISSUES: None (148.0s). No security or
  scope concerns; called the validation boundaries and doc sync correct.
- **claude** — pending. (This run is itself an end-to-end exercise of the fix: it goes
  through the installed consult, which now carries the `[1m]` default.)

## Narrative corrections (architect review, PR #1657 comment 5593490746)

Three factual corrections to my review record. All three were right; none required a code
change, and the eight seeded files are untouched. Applied to the PR body and to the
Investigate section above.

1. **Over-broad framing of the five attempts.** I wrote that the bug hit "any large
   review" and implied all five attempts were context failures. Four were; the third
   builder-side attempt was a subscription usage limit. Scoped to the observed repeated
   failures on PR #1640.
2. **Over-broad runtime claim.** I wrote that the SDK returns 1M "only when the id carries
   a `[1m]` suffix, and 200K otherwise." The window function has four branches before the
   200K fallback, so that is not universal. Rewritten as the narrower claim I actually
   verified: bare `claude-opus-5` → 200K, `claude-opus-5[1m]` → 1M, under SDK 0.2.105
   and 0.2.141.
3. **Over-claimed mechanism.** I wrote that the model "reads its way past 200K and the API
   rejects the request." The saved sessions establish substantial prior tool activity and
   accumulated-context exhaustion surfacing as `Prompt is too long` — not a specific
   client-vs-server rejection point, and not that all 41 files were read in full.

The gemini correction is the one worth keeping: I asserted "gemini completed normally"
straight from the issue text without opening the artifact. It is a 358-byte skip notice.
That is exactly the `lessons-critical.md` line about verifying claims against the actual
file rather than trusting a summary — and I had already applied that discipline to the
seeded patch while skipping it on the issue's own prose.

**Outstanding:** commit `b73c5d21d`'s message carries corrections 2 and 3 in its original
wording. Correcting it means an amend + force-push, which would invalidate the seven green
CI checks and the completed reviews. Flagged to the architect rather than decided here.

## Architect integration review — disposition (PR #1657 comment 5593523517)

Independent Claude integration review: **COMMENT**, 254.0s, no implementation blocker.
The architect adjudicated its findings against the SDK rather than accepting them:

1. **"`[1m]` reaches the provider as part of the model id" — rejected.** The reviewer
   stopped at internal normalization (`X5`). I re-verified the architect's counter-evidence
   in the locked SDK 0.2.105: `UT(q) = q.replace(/\[(1|2)m\]/gi, "")`, applied at
   `beta.messages.create({...P, model: UT(P.model)})`, at `countTokens`, and on the bedrock
   path. Internal normalization keeps the marker; request construction strips it. The
   context budget and the beta header are separate effects. My PR statement was correct.
2. **Account/provider availability — advisory, not demonstrated breakage.** Added the
   explicit opt-out to the PR record as asked: `consult.models.claude: "claude-opus-5"`
   retains the previous selection and 200K budget on the inspected runtimes, alongside
   `--model-id` and `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. No automatic fallback and no
   entitlement-policy change requested or made.
3. **Version wording / reflow — non-blocking.** No rewrite of the seeded patch.

Direction taken: correct the narrative in a **new commit**; do not amend or force-push
`b73c5d21d` to revise historical wording. The corrected PR body and this committed
narrative are the durable correction — which also resolves the decision I had referred
upward. The seven green CI checks and completed reviews stay valid.

All eight seeded files remain unchanged and still hash-match the handoff manifest.

## Final CMAP verdicts (PR #1657)

All three lanes returned. **gemini APPROVE/HIGH**, **codex APPROVE/HIGH**,
**claude APPROVE/HIGH** (750.4s) — no blocking issues from any lane.

Claude's review was the substantive one. It independently confirmed the root cause, the
regex (superset of the old pattern, ReDoS-safe, 200-char bound correct), and — the check
I had not thought to make — that admitting `[` and `]` into a validated identifier opens
no injection surface: the gemini lane passes the id through `spawn(bin, args)` as an argv
element with no `shell: true`, and `computePersistentOutputPath` keys on the lane name,
not the model id, so the suffix never reaches a filename.

It also found something that corrected **my** narrative, which is worth recording:

- I wrote that the mechanism was "verified against the bundled runtime in SDK 0.2.105 and
  0.2.141". That is wrong for 0.2.141 — **it has no bundled runtime**. 0.2.105 ships the
  whole thing as `cli.js`; 0.2.141 is a thin client with no `[1m]` logic of its own that
  delegates to a runtime-resolved native binary from
  `@anthropic-ai/claude-agent-sdk-<platform>`. I had taken the 0.2.141 half from the
  handoff's investigation rather than checking it. Verified it myself now: the native
  binary carries the identical gate `rG(H) = /\[1m\]/i.test(H)`, plus
  `context-1m-2025-08-07` (4×) and `CLAUDE_CODE_DISABLE_1M_CONTEXT` (2×). The claim was
  true; my description of *how* it was true was not. PR body corrected.
- Consequence worth knowing, not a blocker: on 0.2.141+ the `[1m]` semantics live in a
  runtime-resolved binary this repo does not pin (`^0.2.41` spans the architectural
  shift). If the lane ever regresses to `Prompt is too long` again, check the installed
  runtime version before the Codev source.

### Claude's minor items — disposition

1. **"Could not verify the suffix-strip claim."** Already adjudicated by the architect and
   re-verified by me on *both* runtimes: `UT(q)` in 0.2.105 and `KL(H)` in the 0.2.141
   native binary, both `replace(/\[(1|2)m\]/gi,"")`, applied at request construction. The
   reviewer stopped at `X5` normalization, which re-attaches the marker. Not a defect;
   the PR body now shows the evidence on both runtimes rather than asserting it.
2. **`CLAUDE_CODE_DISABLE_1M_CONTEXT` nuance** (concrete ids keep the suffix on the wire
   with no beta header; aliases are stripped). Doc line is incomplete, not wrong. Touching
   it means editing a seeded doc file — referred to the architect, not done unilaterally.
3. **Premium >200K pricing exposure.** Added a line to the PR body noting `maxBudgetUsd: 25`
   still caps each consultation and that the exposure exists only where the lane previously
   hard-failed. A line in shipped `consult.md` would need a seeded-file edit — referred up.
4. **`consult stats` splits claude history across two model ids.** Cosmetic; noted, not fixed.
5. **"25 uncommitted lines in the thread log."** True at review time; committed since in
   `e339b399f`. Resolved.

CI on head `e339b399f`: **all 7 checks pass**.
