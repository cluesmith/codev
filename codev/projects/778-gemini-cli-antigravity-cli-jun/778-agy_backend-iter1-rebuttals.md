# Phase 1 (agy_backend) — Iteration-1 Implement Rebuttals

**Verdicts:** Gemini COMMENT · Codex REQUEST_CHANGES · Claude APPROVE
**Disposition:** All points **accepted and addressed** (no rejections). Full suite green after fixes
(152 files, 3209 passed, 0 failed).

## Codex (REQUEST_CHANGES)
- **CX1 — `resolveAgyBin()` only did realpath heuristics, not behavioral `--version` verification of a
  PATH candidate.** ✅ Added `agyRespondsToVersion(bin)` (runs `--version`, read-only) and require it
  for the **untrusted PATH-fallback** candidate (in addition to the realpath IDE-rejection). The
  canonical `~/.local/bin/agy` and the explicit `CODEV_AGY_BIN` override remain realpath-trusted (no
  per-call subprocess on the common path). So a bare PATH `agy` is now accepted only if it both isn't
  the IDE *and* behaves like the headless CLI.
- **CX2 — `verifyAgy()` used `spawnSync`, so OAuth detection only happened after exit/timeout (could
  stall `codev doctor`).** ✅ Rewrote `verifyAgy()` as **async + streaming**: it spawns `agy --print`,
  scans the early stdout/stderr stream, and **terminates early the instant the OAuth URL appears**,
  reporting "needs login" promptly instead of waiting out the timeout. Call site now `await`s it.
- **CX3 — Test gaps (no behavioral PATH-candidate verification; no fast unauthed doctor test).** ✅
  Added: a `agyRespondsToVersion` unit test (version-emitting vs not vs throwing), and a doctor test
  asserting a **prompt "needs login"** when agy streams the OAuth URL (replacing the obsolete
  spawnSync-timeout test).

## Gemini (COMMENT)
- **G1 — Dead `VERIFY_CONFIGS['Gemini']` (old `gemini --yolo` config) left in `doctor.ts`.** ✅
  Removed (the gemini lane is verified via `verifyAgy`, not `VERIFY_CONFIGS`), per the plan's "drop
  the `gemini`-CLI/`--yolo` check."
- **G2 — Fake hardcoded-config test in `consult.test.ts` masked the new `'agy'` cli.** ✅ Rewrote
  `should have correct CLI configuration for each model` to assert the **real exported
  `_MODEL_CONFIGS`** (`gemini.cli === 'agy'`, no `--model` arg, `envVar` null), so a backend change is
  now caught.

## Claude (APPROVE)
- **Minor — `agySkipContent()` called twice on the no-binary path.** ✅ Store the result once.
- (Confirmed dead `VERIFY_CONFIGS['Gemini']` — same as G1, fixed.)

## Net
Binary resolution now behaviorally verifies untrusted PATH candidates; the doctor auth probe is fast
(streaming OAuth detection); dead code removed; the config test asserts reality. Scope unchanged
(lean backend swap). Full suite green.
