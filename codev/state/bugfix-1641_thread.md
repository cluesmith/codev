# bugfix-1641 — `consult -m claude` fails with "Prompt is too long"

Issue: #1641. Protocol: BUGFIX (strict). Branch: `builder/bugfix-1641`.
Base commit: `c4ad613fcda59ad4c996eb59c66794a80e57e7c2`.

## Investigate

Reproduced the failure mechanism from evidence rather than by burning subscription
quota on another 5-minute review: the two saved failing sessions cited in the
architect's prior investigation show 29 and 51 tool calls with last-successful
input of 174,521 and 175,930 tokens respectively, then `Prompt is too long`. That
is a context-window ceiling at ~200K, not an oversized opening prompt. (The
opening prompt for `--protocol pir --type impl --project-id 1481` inlines
spec 2.5K + plan 34K ≈ 10K tokens — nowhere near a limit.)

Root cause, verified against the actual source and the bundled runtime:

1. `packages/codev/src/commands/consult/index.ts:419` —
   `DEFAULT_CLAUDE_MODEL = 'claude-opus-5'` (a bare id, no context suffix).
2. The Agent SDK bundles a Claude Code runtime whose context budget is
   `function jk(q,K){ ... if(ZG(q))return 1e6; ... return qh1}` with
   `qh1=200000` and `ZG(q)=/\[1m\]/i.test(q)`. A bare `claude-opus-5` is
   therefore budgeted at **200,000** tokens; `claude-opus-5[1m]` at
   **1,000,000**. Confirmed by inspecting the bundled `cli.js` in
   `@anthropic-ai/claude-agent-sdk@0.2.105` (the checkout's locked version);
   the installed 0.2.141 behaves the same.
3. `runClaudeConsultation` gives the lane `allowedTools: ['Read','Glob','Grep']`
   and `maxTurns: 200`, so an impl/integration review of a 41-file PR reads
   dozens of files and accumulates past 200K → the API returns
   `Prompt is too long`.
4. `packages/codev/src/lib/consult-lanes.ts:77` —
   `MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/` rejects `[` and `]`,
   so **no user could work around it** via `consult.models.claude` or
   `--model-id claude-opus-5[1m]`. That is why the failure was unrecoverable
   across 5 attempts and 2 callers.

Why gemini and codex were unaffected: different backends, different context
budgets — neither routes through the Agent SDK's model-id → window mapping.

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
