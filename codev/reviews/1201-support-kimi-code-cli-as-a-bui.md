# PIR Review: Support Kimi Code CLI as a builder

Fixes #1201

## Summary

Adds the Kimi Code CLI (`kimi`, ≥ 0.27.0) as a supported **builder** harness — `shell.builder: "kimi"` / `builderHarness: "kimi"` / `--builder-cmd kimi` now produce a working builder instead of the #1062 false-Claude fallthrough (which appended `--append-system-prompt` and a positional prompt, both rejected by kimi, and could route a stale Claude `--resume <uuid>` into it). Because Kimi documents no system-prompt flag and no positional prompt, the launch shape is provider-owned: a **seed-session bootstrap** (validated by spike task-Iptx) delivers role + task via a one-shot `kimi -p` whose captured session id pins a `kimi -S <id> --yolo` TUI loop, with a Tower-side **readiness barrier** (sentinel-gated, store-verified `BEGIN` kick) and a per-harness delayed-Enter pacing knob so `afx send` actually submits. Kimi as an *architect* is explicitly out of scope (stage 2).

## Files Changed

`git diff --stat $(git merge-base main HEAD)` (excluding porch state commits):

- `packages/codev/src/agent-farm/utils/harness.ts` (+263) — `KIMI_HARNESS`, detection, `buildBuilderLaunchScript` / `seedDelivery` / `messagePacing` interface capabilities, `buildResume`
- `packages/codev/src/agent-farm/utils/kimi-session-discovery.ts` (+197, new) — store scan / ownership verify / state reader (fail-soft; `KIMI_CODE_HOME`-aware)
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` (+111/−9) — provider-owned script branch, `.builder-seed.txt`, `seedKick` pass-through
- `packages/codev/src/agent-farm/servers/seed-kick.ts` (+194, new) — sentinel watcher + grace + store-verified kick retry ladder
- `packages/codev/src/agent-farm/servers/message-pacing.ts` (+55, new) — per-target pacing resolution (worktree-marker probe first, config-resolved harness fallback)
- `packages/codev/src/agent-farm/servers/message-write.ts` (+16/−2) — optional `pacing.enterDelayMs` override
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+20/−2) — `seedKick` on terminal create; pacing at both send paths
- `packages/codev/src/agent-farm/servers/tower-cron.ts` (+6/−2) — pacing at cron delivery
- `packages/core/src/tower-client.ts` (+24) — `SeedKickRequest` wire type on `createTerminal`
- `packages/codev/src/agent-farm/lib/tower-client.ts` (+1) — re-export
- `packages/codev/src/commands/doctor.ts` (+110/−2) — kimi presence/minVersion, auth heuristic, `kimi doctor` config check, store smoke probe, architect-kimi warning
- Tests (+~900 across 8 files): new `kimi-session-discovery.test.ts`, `seed-kick.test.ts`, `message-pacing.test.ts`; extended `harness.test.ts`, `spawn-worktree.test.ts`, `config.test.ts`, `discover-resume-session.test.ts`, `bugfix-584-send-multiline-pacing.test.ts`
- Docs: `codev/resources/arch.md` (+16/−2, dedicated Kimi subsection), `codev/resources/commands/agent-farm.md` + `codev-skeleton/resources/commands/agent-farm.md` (builder-harness config examples — skeleton mirrored)
- `codev/spikes/pir-1201-kimi-builder-demo.mjs` (+193, new) — runnable live-demo driver (real kimi, real dist modules)
- `codev/plans/1201-…md`, `codev/state/pir-1201_thread.md`

Total: 27 files, +2378/−23.

## Commits

- `2cf424c1` [PIR #1201] Kimi harness: detection, seed-session launch script, builder resume
- `8e86c411` [PIR #1201] Tower: sentinel-gated BEGIN delivery + per-harness Enter pacing
- `3d407856` [PIR #1201] doctor: kimi presence, truthful auth heuristic, store smoke probe
- `f0754430` [PIR #1201] Docs: kimi builder harness (arch.md + config examples, skeleton mirror)
- `b27e2d38` [PIR #1201] Pacing resolution is fully best-effort; widen cron session type
- `ea6607c6` [PIR #1201] Pin Kimi Enter delay with live bisect evidence
- `6b39ca5c` [PIR #1201] Live demo driver + results (all 5 checklist steps pass)
- (plus `d49c292b` plan draft and porch state commits)

## Test Results

- `pnpm build`: ✓ pass (types → core → codev, incl. dashboard + skeleton copy)
- `pnpm test` (vitest): ✓ pass — 3592 passed, 48 skipped (~75 new tests). Porch's build/tests checks green at both the dev-approval and review transitions.
- **#929-class regression covered from four angles**: `kimi` + a stale Claude `.jsonl` can never yield `--resume <claude-uuid>` or `--append-system-prompt` (harness `buildResume`, `discoverResumeSession`, config/override resolution, generated-script assertions).
- **Live validation on real kimi 0.27.0**:
  - *Enter-delay bisect* (POC probe-10 method): 80ms and 100ms swallowed; 120/250/500/1000ms submit → threshold ≈ 100–120ms; shipped `KIMI_ENTER_DELAY_MS = 1000` (~9x margin; latency-only cost).
  - *Demo driver* (`node codev/spikes/pir-1201-kimi-builder-demo.mjs`): 5/5 PASS — seed bootstrap + id capture; sentinel-gated store-verified BEGIN (`lastPrompt="BEGIN"`); multiline delivery at pinned delay; inner-restart context retention (role token + task recalled verbatim after killing the TUI); `buildResume` returns the pinned id. The spike addendum's open question — does ack-and-wait hold with a task attached? — **held**; the pre-planned role-only-seed fallback was not needed.
  - *Human full-path verification at the dev-approval gate*: real `afx spawn` through Tower (branch build via local-install); all 4 checklist items passed live.

## Architecture Updates

Routed to the **COLD** tier (`codev/resources/arch.md`, updated in commit `f0754430`): a dedicated "Kimi Builder Harness (Issue #1201)" subsection under Agent Farm Internals — builder-only status, the seed-session bootstrap, the sentinel + store-verified BEGIN barrier, per-harness pacing with the marker-probe resolution order, explicit-ID resume, and the caveats (undocumented store surfaces + 0.27.0 pin + doctor smoke probe; **no write-guard parity** — Kimi has no documented hook seam; in-memory kick lost on Tower restart during the seed window). The harness enumeration lines in the same section were extended.

No **HOT** tier (`arch-critical.md`) change: kimi support is subsystem detail, not a top-10 always-on system-shape fact; the existing hot facts (runtime resolution, dual-tree mirroring, porch/state invariants) already cover the decision surface this touches.

## Lessons Learned Updates

Routed to the **COLD** tier (`codev/resources/lessons-learned.md`, Architecture section, this commit):

1. *Advisory decorators on critical paths must be failure-total* — the pacing resolver's narrow try/catch let a mocked-out dependency 500 every `/api/send` in the test env; the whole body now degrades to defaults.
2. *Per-instance runtime facts that config cannot know are best carried by a self-describing on-disk marker in the instance's own directory* — `.builder-kimi-session` makes pacing correct for `--builder-cmd` override spawns across Tower restarts with zero schema migration.

No **HOT** tier (`lessons-critical.md`) change: both lessons are architecture-pattern reference material, not behavior-changing cross-cutting rules of the always-on caliber (the cap is full of broader rules that would each beat these on displacement).

## Things to Look At During PR Review

- **PR-consultation finding (codex, REQUEST_CHANGES — FIXED)**: the original delivery confirmation used `lastPrompt.includes(kickMessage)`. Real defect: on a fresh spawn `lastPrompt` initially holds the *seed prompt*, whose ack-and-wait wrapper itself says "wait for BEGIN" — so the substring check reported success before the kick ever submitted, silently defeating the swallowed-Enter recovery (the live demo's happy path masked it: the kick genuinely landed, so the false-positive window was never observed). Fixed in `seed-kick.ts` by requiring whitespace-normalized **equality** (submitted messages land in `lastPrompt` with newlines flattened to spaces — observed), with two pinning regression tests (seed-prompt-containing-BEGIN must NOT confirm and must escalate to the Enter re-send; a multi-line kick payload must still confirm through the flattening). Gemini and Claude both returned APPROVE; PIR's consultation is single-pass, so this fix was **not** independently re-reviewed — please eyeball `confirmed()` in `seed-kick.ts` at the `pr` gate. The live demo was re-run after the fix: still 5/5 PASS (no false negative).
- **`seed-kick.ts` retry ladder semantics**: `updatedAt` movement is deliberately NOT trusted as confirmation (the TUI touches the store on open, which would false-positive and suppress the Enter re-send). A false *negative* only costs a duplicate BEGIN + loud warn.
- **`message-pacing.ts` resolution order**: marker probe before config, by design (override robustness — see plan-review note). The probe stats one file per message send; sends are rare, so no perf concern.
- **Undocumented-surface reliance is deliberately narrow**: discovery scans only `sessions/*/*/state.json` (not `session_index.jsonl` — one undocumented surface instead of two); every reader is fail-soft to the fresh-with-role path; doctor carries the drift probe.
- **`kimiTuiCmd` appends `--yolo`** unless the user already passed it; `--auto` is deliberately never used (documented conflict with `--yolo`; suppresses agent→user questions the gate workflow needs).
- **Kimi builders have NO write-guard** (#1018 parity impossible — no documented hook seam). Documented in arch.md and the config docs; the "static deny rules" hint in Kimi's `-p` docs is flagged as follow-up investigation, not a claimed guarantee.
- Doctor's kimi lane follows the existing print-flow style (no dedicated unit tests, matching the opencode/gemini architect-warning precedent); its logic-bearing pieces (`kimiStoreLayoutLooksDrifted`, discovery readers) are unit-tested in the discovery suite.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1201` → **View Diff** (or `gh pr diff`).
- **Standalone demo (no Tower changes needed)**: from the branch checkout, `pnpm build` then `node codev/spikes/pir-1201-kimi-builder-demo.mjs` — requires an authenticated `kimi` ≥ 0.27.0; prints PASS/FAIL for all five checklist steps.
- **Full Tower path**: `pnpm -w run local-install` (restarts Tower), then from the main workspace root: `afx spawn --task "any small task" --builder-cmd kimi` → watch seed → `__CODEV_KIMI_SEED_DONE__` → BEGIN in the builder pane; `afx send <builder-id>` with a >3-line message → submits as one message; kill the TUI (`Ctrl+C` once) → restart resumes with context; `afx spawn --resume` after killing the terminal.
- `codev doctor` with kimi installed → presence + version gate, heuristic auth line, smoke probe; with `shell.architect: "kimi"` → builder-only warning.

---

*Maintainer note: please add the `area/tower` label to issue #1201 (we can't set labels cross-fork).*
