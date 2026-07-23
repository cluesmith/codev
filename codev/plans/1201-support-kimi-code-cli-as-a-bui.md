# PIR Plan: Support Kimi Code CLI as a builder

**Issue**: cluesmith/codev#1201
**Spike**: `codev/spikes/task-Iptx-kimi-code-cli-support.md` (verdict: Feasible with Caveats; POC-validated end-to-end, incl. the post-review addendum) + `codev/spikes/task-Iptx-kimi-poc.sh`
**Scope fence** (architect-confirmed): exactly the builder-MVI checklist in #1201. NO architect parity (no `resolveArchitectLaunch` / `CrashLoopFallback` changes), NO ACP / `kimi server` adapter. Write-guard parity is a documented caveat only.
**Evidence rule**: documented-Kimi claims cite only https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html. Session store layout, `session_index.jsonl`, and the `session.resume_hint` stream-json meta line are **undocumented, observed** surfaces (kimi 0.27.0) — pinned via a minimum-version check and a session-store smoke probe in doctor.

## Understanding

Today, configuring `.codev/config.json` `shell.builder: "kimi"` (or `builderHarness: "kimi"`) produces a broken builder:

1. `detectHarnessFromCommand('kimi')` (`packages/codev/src/agent-farm/utils/harness.ts:309-322`) doesn't recognize `kimi` → `resolveHarness` falls through to `CLAUDE_HARNESS` (`harness.ts:372` — the #1062 fallthrough).
2. The false Claude harness makes `startBuilderSession` (`packages/codev/src/agent-farm/commands/spawn-worktree.ts:800-808`) generate a script appending `--append-system-prompt "$(cat role)"` and a positional prompt `"$(cat .builder-prompt.txt)"`. Kimi rejects both (observed: unknown option / `unknown command`, exit 1) → the in-script `while true` loop restarts into the same failure forever.
3. The false Claude harness also exposes Claude's `buildResume`, so a stale Claude `.jsonl` for the worktree path can route `--resume <claude-uuid>` into `kimi` (the pre-#929 crash-loop class).

Kimi has **no documented system-prompt flag and no documented positional prompt**, so the fix can't be another pair of role args — the whole builder launch shape must be provider-owned. The spike validated the **seed-session bootstrap**: a `kimi -p "<role + task briefing, ack-and-wait wrapper>" --output-format stream-json` seed turn in the worktree, session id captured from the `session.resume_hint` meta line, persisted, then the interactive TUI looped with `kimi -S <id> --yolo` — role/task context survives inner restarts. The spike addendum makes the **task-delivery readiness barrier mandatory**: bytes written to the PTY during the ~5–15s seed window have no defined consumer (observed: silently lost), so BEGIN delivery must be gated on an explicit sentinel and verified against the session store.

## Proposed Change

Eight work items, matching the issue checklist 1:1.

### 1. `KIMI_HARNESS` + detection (`utils/harness.ts`)

- `detectHarnessFromCommand`: add `if (basename.includes('kimi')) return 'kimi';`. This alone kills the #1062 false-Claude fallthrough for this CLI.
- New `KIMI_HARNESS: HarnessProvider`:
  - `buildRoleInjection`: **throws** with a clear "Kimi is builder-only; architect support is stage 2 (use claude or codex)" message — the OPENCODE pattern (`harness.ts:174-181`). Any architect-path use fails loudly instead of silently mis-launching.
  - `buildScriptRoleInjection`: returns `{ fragment: '', env: {} }` (role cannot ride argv; the real shape comes from the new capability below).
  - `buildResume` — see item 4.
  - **No `session` block.** The architect stored-UUID contract requires `newSessionArgs(sessionId)` (mint-and-pin), which Kimi cannot satisfy (no documented caller-supplied ID). Generalizing that contract (`newSessionArgs` optional + async `seedSession`) is the stage-2 architect work, explicitly out of scope. Builder resume verification lives inside `buildResume` via the discovery module's ownership check instead.
- New **optional provider capability** for provider-owned builder launch shapes:
  ```ts
  buildBuilderLaunchScript?(ctx: {
    worktreePath: string; baseCmd: string;
    promptFile: string | null;       // .builder-prompt.txt (fresh paths)
    roleFile: string | null;         // .builder-role.md (null on no-role spawns)
    seedFile: string | null;         // .builder-seed.txt (fresh paths; see item 2)
    resume?: { sessionId: string };  // resume path
  }): string;
  ```
  Only Kimi implements it; all existing harnesses are untouched (flag/argv shapes keep the current generic scripts).
- Kimi seed-delivery metadata on the provider (consumed by items 3/5): sentinel prefix `__CODEV_KIMI_SEED_DONE__`, kick message `BEGIN`, grace ms, and `messagePacing: { enterDelayMs: <pinned> }`.

### 2. Provider-owned launch shape (`commands/spawn-worktree.ts`)

`startBuilderSession` (`spawn-worktree.ts:746`) and `buildWorktreeLaunchScript` (`spawn-worktree.ts:869`) branch: when the resolved harness has `buildBuilderLaunchScript`, use it for the script content (fresh-with-role, fresh-no-role, and resume variants all flow through the one capability). Generated Kimi fresh script (shape validated by spike POC 6):

```bash
#!/bin/bash
cd "<worktree>"
if [ ! -s .builder-kimi-session ]; then
  kimi -p "$(cat '.builder-seed.txt')" --output-format stream-json \
    | node -e '<line-wise JSON parse: print session_id of the session.resume_hint meta line; drain stdin to EOF>' \
    > .builder-kimi-session
fi
SID="$(cat .builder-kimi-session)"
if [ -z "$SID" ]; then echo "Kimi seed failed (no session id captured) — check 'kimi login' / network"; exit 1; fi
echo "__CODEV_KIMI_SEED_DONE__ $SID"
while true; do
  kimi -S "$SID" --yolo
  echo ""; echo "Agent exited. Restarting in 2 seconds... (Ctrl+C to quit)"; sleep 2
done
```

Key properties:
- **Seed failure exits before the loop** → surfaced once, not restart-looped (unauthenticated/network failures don't spin).
- **Seed is idempotent** (`-s` guard): a script relaunch reuses the persisted id, so role/task context survives inner restarts — and the sentinel is re-printed, re-arming delivery gating.
- `--yolo` is harness-owned (matches `claude --dangerously-skip-permissions` semantics; `--auto` rejected — it suppresses agent→user questions, which gates/Q&A depend on; the two conflict per the command reference). Users configure plain `shell.builder: "kimi"`.
- The extraction one-liner drains stdin to EOF before exiting (avoids EPIPE killing the seed mid-turn; the resume_hint line's position in the stream is undocumented).
- `.builder-seed.txt` (written by spawn-worktree on fresh paths) = ack-and-wait wrapper + role content + task briefing (the prompt): "initialize, do not act, do not use tools, acknowledge and wait for BEGIN". Primary design per the spike addendum; **fallback if the live probe shows the discipline doesn't hold with a task attached**: role-only seed, with the full task prompt becoming the delivered kick payload (the delivery machinery in item 3 is payload-agnostic, so the fallback is a content change, not a design change).
- Resume-variant script (from `buildResume`): no seed, no sentinel — straight `while true; do kimi -S '<id>' --yolo; …` loop.
- `.builder-kimi-session` / `.builder-seed.txt` are spawn artifacts in the same class as the existing untracked `.builder-prompt.txt` / `.builder-role.md` / `.builder-start.sh` — same handling (never committed).

### 3. Readiness barrier + store-verified BEGIN delivery (Tower)

Per the spike addendum this is **required scope**, and it lives Tower-side (Tower already streams PTY output; it survives the spawn CLI exiting).

- `createTerminal` (`packages/core/src/tower-client.ts:436`, `handleTerminalCreate` at `servers/tower-routes.ts:560`) gains an optional `seedKick` field: `{ sentinel, message, graceMs, verify: { kind: 'kimi-session-store', worktreePath } }`. `startBuilderSession` populates it from the harness's seed-delivery metadata on Kimi fresh spawns only.
- New module `packages/codev/src/agent-farm/servers/seed-kick.ts` — `armSeedKick(session, opts, log)`:
  1. Subscribe to the session's `'data'` events (`PtySession` is an `EventEmitter`, `terminal/pty-session.ts:289`); line-buffer and scan for `__CODEV_KIMI_SEED_DONE__ <session-id>` (robust to chunk boundaries); capture the id; unsubscribe.
  2. Fixed grace (~2.5s) for the composer to be ready.
  3. Write the kick (`BEGIN`, single line) via `writeMessageToSession` with the Kimi Enter delay (item 5).
  4. **Store-verified delivery** (the actual guarantee): poll the session's `state.json` (`lastPrompt`/`updatedAt` — observed to update on submit) via the discovery module (item 4). On timeout (~10s): re-send Enter (dominant observed failure is a swallowed Enter); still nothing → re-send the kick once; still nothing → loud WARN in the Tower log and terminal broadcast. Self-healing also absorbs any residual Enter-delay uncertainty.
  5. Sentinel timeout (~180s) → loud "seed never completed" WARN.
- Armed kicks are in-memory: a Tower restart during the seed window loses the kick. Documented caveat + remediation (`afx send <builder-id> "BEGIN"`).

### 4. Session discovery: `buildResume` + ownership (`utils/kimi-session-discovery.ts`, new)

Sibling module to `claude-session-discovery.ts`, all fail-soft (malformed/missing → null/false, never throw). Store root: `KIMI_CODE_HOME` env else `~/.kimi-code` (env var documented for doctor; the layout beneath is undocumented/observed), with an `opts.kimiHome` test seam:

- `findLatestKimiSessionId(absolutePath)`: scan `sessions/wd_*/session_*/state.json`, filter `workDir === absolutePath` (realpath-tolerant on both sides, mirroring `claude-session-discovery.ts:100-106`), pick max `updatedAt`. Deliberately does **not** read `session_index.jsonl` — one undocumented surface instead of two; the directory scan is the ground truth the index merely mirrors.
- `verifyKimiSessionOwnership(sessionId, cwd)`: session dir exists AND `state.json.workDir === cwd` — exact-path match, stronger than Claude's encoded-dir check.
- `readKimiSessionState(sessionId)` → `{ workDir, updatedAt, lastPrompt } | null` — consumed by the seed-kick verifier (item 3) and the doctor smoke probe (item 6).

`KIMI_HARNESS.buildResume(worktreePath)`:
1. `.builder-kimi-session` file in the worktree → its id, if `verifyKimiSessionOwnership` passes (a stale/GC'd id falls through rather than baking a fast-failing `-S` into the restart loop — kimi fast-fails on unknown ids, observed).
2. Else newest store session with exact `workDir` match.
3. Else `null` → `discoverResumeSession` (`commands/spawn.ts:87`) falls back to the fresh-with-role seed path — exactly the semantics that make explicit-ID preferable to `--continue` (a roleless fresh session is never possible).

Returns `{ sessionId, args: ['-S', id], scriptFragment: "-S '<escaped-id>'" }` — the existing interface, unchanged.

### 5. Per-harness Enter-delay knob (`servers/message-write.ts`)

Kimi's paste window is longer than Claude's: 80ms delayed Enter → not submitted; 1s → submitted (observed). Without this, `afx send` to a Kimi PTY silently doesn't submit.

- `writeMessageToSession(session, message, noEnter, delayOffset?, pacing?: { enterDelayMs?: number })` — when set, overrides both `SIMPLE_ENTER_DELAY_MS` (50) and `PACED_ENTER_DELAY_MS` (80). Absent → current behavior byte-for-byte (Claude/codex/gemini paths untouched).
- `HarnessProvider.messagePacing?: { enterDelayMs }`; only Kimi sets it. The value is **bisected live during implement** (threshold is between 80ms and 1s) and pinned with margin; plan placeholder 1000ms.
- Call sites resolve pacing from the target terminal's registered type + workspace: builder → `getBuilderHarness(workspacePath)`, architect → `getArchitectHarness(workspacePath)`, else default — a small `resolvePacingForTarget` helper used by `deliverBufferedMessage` + the direct path (`tower-routes.ts:111`, `:1377`) and cron delivery (`tower-cron.ts:323`). The seed-kick writer (item 3) uses the same pacing directly.

### 6. `codev doctor` (`src/commands/doctor.ts`)

- `AI_DEPENDENCIES` (`doctor.ts:156`): add Kimi — `kimi --version` presence, **`minVersion: '0.27.0'`** (the version the undocumented surfaces were observed against), install hint → Kimi Code docs.
- **Truthful auth heuristic** (no billed probe, ever): custom `verifyKimi()` reporting credential-artifact presence (`<kimi-home>/credentials/kimi-code.json` / `oauth/kimi-code` — undocumented layout, labeled as a heuristic in the output) with `kimi login` guidance when absent. Optionally also shell out to `kimi doctor` (config validity; documented exit 0/1 — explicitly *not* an auth check, and reported as such).
- **Session-store smoke probe**: when kimi is installed and a store exists, verify the observed layout still parses (`sessions/wd_*/session_*/state.json` with a `workDir` key) via `readKimiSessionState`; warn loudly on drift ("undocumented surface changed — resume and BEGIN-delivery verification may fail; check for a Kimi update").
- Architect-shell branch (`doctor.ts:687-712` pattern): `resolvedHarness === 'kimi'` → warn "Kimi is builder-only (stage 2 for architects); use claude or codex for the architect".

### 7. Docs

- `codev/resources/arch.md` §"Supported Architect Harnesses & Conversation Resume (#929)" + the builder-harness/role-injection material around `arch.md:256`: kimi is builder-only; the seed-session bootstrap pattern; sentinel + store-verified BEGIN delivery; per-harness Enter pacing; **no write-guard parity** (Kimi has no documented hook seam — a Kimi builder does not get the #1018 PreToolUse write isolation; the `-p` docs' "static deny rules remain in effect" hints at a deny-rule surface outside the command reference — follow-up investigation, not a claimable guarantee); role rides a user turn, not a system prompt (same tradeoff that deferred agy, #1063); undocumented-surface reliance + the 0.27.0 pin.
- Config examples for `shell.builder: "kimi"` / `builderHarness: "kimi"` wherever harness config is documented; grep BOTH `codev/` and `codev-skeleton/` for harness enumerations before claiming done (per lessons-critical). Framework-file changes get mirrored to the skeleton; `arch.md` itself is user-evolved (no skeleton mirror).
- Review-time: route any new facts/lessons by hot/cold tier (Spec 987).

### 8. Out of scope (fenced)

No changes to `resolveArchitectLaunch`, `tower-instances.ts` launch sites, `tower-terminals.ts` restart-bake sites, `CrashLoopFallback`/`session-manager.ts`, or `commands/architect.ts`. No ACP/`kimi server`. Kimi-as-architect fails loudly via the `buildRoleInjection` throw + doctor warning.

## Files to Change

| File | Change |
|---|---|
| `packages/codev/src/agent-farm/utils/harness.ts` | `KIMI_HARNESS`; `BUILTIN_HARNESSES.kimi`; `detectHarnessFromCommand` kimi match; `buildBuilderLaunchScript` + `messagePacing` + seed-delivery metadata on the `HarnessProvider` interface; Kimi `buildResume` |
| `packages/codev/src/agent-farm/utils/kimi-session-discovery.ts` | **New** — store scan, ownership verify, state reader (`KIMI_CODE_HOME`-aware, `kimiHome` test seam) |
| `packages/codev/src/agent-farm/commands/spawn-worktree.ts` | Branch `startBuilderSession` / `buildWorktreeLaunchScript` on `buildBuilderLaunchScript`; write `.builder-seed.txt`; pass `seedKick` through `createPtySession` |
| `packages/codev/src/agent-farm/servers/seed-kick.ts` | **New** — sentinel watcher + grace + kick + store-verified retry state machine |
| `packages/codev/src/agent-farm/servers/tower-routes.ts` | `handleTerminalCreate` accepts/forwards `seedKick`; message paths pass resolved pacing |
| `packages/codev/src/agent-farm/servers/message-write.ts` | Optional `pacing.enterDelayMs` override |
| `packages/codev/src/agent-farm/servers/tower-cron.ts` | Pass resolved pacing at `deliverMessage` |
| `packages/core/src/tower-client.ts` | `createTerminal` options + `seedKick` field |
| `packages/codev/src/commands/doctor.ts` | Kimi presence/minVersion, auth heuristic, `kimi doctor` config check, session-store smoke probe, architect-kimi warning |
| `packages/codev/src/agent-farm/__tests__/…` + `servers/__tests__/…` | Tests per matrix below (extend `harness.test.ts`, `spawn-worktree.test.ts`, `spawn.test.ts`; new `kimi-session-discovery.test.ts`, `seed-kick.test.ts`; extend message-write + doctor tests) |
| `codev/resources/arch.md` (+ config-example docs, skeleton mirror where framework files change) | Item 7 |

## Risks & Alternatives Considered

- **Risk: undocumented surfaces drift with a Kimi update** (store layout, `resume_hint` meta line). Mitigation: 0.27.0 minimum-version check + doctor smoke probe; all discovery is fail-soft to the fresh-with-role path; the store-verified kick degrades to a loud warning, never a hang.
- **Risk: ack-and-wait discipline fails with a task attached** (model starts acting during the seed turn under `-p`'s auto permission policy). Mitigation: validated by live probe before pinning; fallback design (role-only seed, task as kick payload) is pre-planned and payload-compatible with the same delivery machinery.
- **Risk: Tower restarts during the seed window** → armed kick lost. Mitigation: documented remediation (`afx send <id> "BEGIN"`); the sentinel re-prints on script relaunch, so a Tower that comes back before the TUI launch still arms correctly on rehydrate only if re-armed — accepted MVI limitation, documented.
- **Risk: EPIPE from the extraction pipe killing the seed mid-turn.** Mitigation: the one-liner drains stdin to EOF.
- **Risk: a stale `.builder-kimi-session` bakes a dead `-S` into the restart loop** (kimi fast-fails on unknown ids). Mitigation: `buildResume` ownership-verifies the file id before using it; the in-script seed guard only skips seeding when the file is non-empty, and a dead id there surfaces as a fast TUI exit → the restart loop's visible error, with `afx spawn --resume` (which re-verifies) as the recovery path.
- **Alternative: `--continue` for resume** — rejected: cwd-scoped and roleless on the no-session case; explicit-ID keeps the null → fresh-with-role fallback correct (spike §8 Q2).
- **Alternative: `--skills-dir` as role channel** — rejected: model-mediated (probabilistic) and replaces the user's skill dirs (spike Approach 2).
- **Alternative: ACP / `kimi server` adapter** — rejected: replaces the entire PTY/terminal model for one CLI (spike Approach 4); also fenced out by the architect.
- **Alternative: client-side (spawn.ts) BEGIN delivery** — rejected: dies with the spawn CLI process; Tower-side survives and owns the PTY stream already.

## Test Plan

### Unit (vitest; existing patterns; `kimiHome` fixture seam)

- **Detection/resolution** (`harness.test.ts`): `detectHarnessFromCommand` → `'kimi'` for `kimi`, `/path/to/kimi`, `kimi --yolo`; `resolveHarness('kimi')` returns KIMI_HARNESS; `KIMI_HARNESS.buildRoleInjection` throws the builder-only error.
- **#929-class regression (required by issue; four angles)**: with `shell.builder`/`--builder-cmd` = `kimi` and a stale Claude `.jsonl` fixture for the worktree path: (a) resolved harness is kimi, not claude (config + override angles); (b) `discoverResumeSession` returns null/kimi-store results — never a Claude uuid; (c) generated launch script contains no `--resume <claude-uuid>` and no `--append-system-prompt`; (d) `kimi` as `architectHarness` fails loudly (throw + doctor warning), never silently resolving Claude flags.
- **Discovery** (`kimi-session-discovery.test.ts`): newest-by-`updatedAt` with exact `workDir`; realpath tolerance; null on empty/missing store; ownership match/mismatch/missing-dir/malformed-`state.json`; `readKimiSessionState` happy/malformed.
- **`buildResume`**: `.builder-kimi-session` precedence; stale file id failing ownership falls through to store scan; nothing → null.
- **Script generation** (`spawn-worktree.test.ts`): fresh script has seed guard, sentinel echo, `-S` loop, `--yolo`, empty-id bailout; no positional prompt, no role flags. Resume script is seedless `-S '<id>'` loop. Non-kimi harness scripts byte-identical to before (regression).
- **Seed-kick** (`seed-kick.test.ts`, fake timers + mock store): sentinel detected across chunked `data` events; nothing written before the sentinel (seed-window write-loss regression); grace honored; verify-success stops retries; swallowed-Enter → Enter re-send → kick re-send → loud warn sequence; sentinel timeout warns.
- **Message pacing** (`message-write` tests): `enterDelayMs` override honored on both short and paced paths; default paths unchanged.
- **Doctor**: kimi presence/minVersion gate; auth-heuristic wording (labeled heuristic, `kimi login` hint, no probe call); smoke-probe drift warning; kimi-as-architect warning branch.

### Live demo (required before requesting dev-approval — real `kimi` 0.27.0)

Runnable demo against a scratch workspace using the locally built CLI (builder command overridden to `kimi`), showing:

1. **Seed-session bootstrap**: fresh spawn → seed runs (`kimi -p`, role + task briefing), session id captured from `session.resume_hint` into `.builder-kimi-session`.
2. **Sentinel-gated BEGIN**: `__CODEV_KIMI_SEED_DONE__ <id>` observed; kick delivered after grace; store-verified (state.json `lastPrompt`/`updatedAt` advanced); builder starts the task.
3. **`afx send` multiline**: >3-line message submits as one message with the bisected/pinned Enter delay (plus single-line and `--no-enter` spot checks).
4. **Inner-restart retention**: exit the TUI → restart loop re-enters `kimi -S <id>` → prior role/task context demonstrably intact.
5. Also exercised: `afx spawn --resume` after killing the terminal (explicit-ID resume), and the null-fallback (remove session file + store dir → fresh-with-role re-seed).
6. `codev doctor` output with kimi installed (presence, auth heuristic, smoke probe).

During the demo build-out: **bisect the Enter-delay threshold** (80ms–1s) and pin the shipped value with margin; **validate the ack-and-wait-with-task seed** (else switch to the pre-planned role-only fallback).

### Delivery mechanics (fork flow)

Branch pushes go to the fork (`mohidmakhdoomi/codev`) via the configured pushurl. PR is cross-fork: `gh pr create -R cluesmith/codev --head mohidmakhdoomi:builder/pir-1201`, body = review file. **No self-merge** — done-state is PR open + CMAP feedback addressed/rebutted + architect notified; maintainers merge. Ask maintainers in the PR conversation to add `area/tower` to issue #1201.
