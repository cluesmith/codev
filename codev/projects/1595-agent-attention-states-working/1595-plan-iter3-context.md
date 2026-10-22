### Iteration 1 Reviews
- gemini: REQUEST_CHANGES — Strong, well-sequenced plan, but needs adjustments for shellper process-tree depth in Phase 4 liveness, the `canResume` branch in `resolveArchitectLaunch` in Phase 6, and dropped-session handling in Phase 5.
- codex: REQUEST_CHANGES — The architecture is strong, but three runtime gaps prevent full compliance with the approved specification.
- claude: REQUEST_CHANGES — Well-researched plan with accurate file targeting and sound phasing, but the architect-resume launch path bypasses the named injection funnel, and the Phase 3/Phase 5 builder-id spaces are conflated.

### Builder Response to Iteration 1
# Plan 1595, iteration 1: rebuttal and disposition

All three reviews returned REQUEST_CHANGES. Every point was checked against the code before acting. All are accepted except two, which are answered with the reason and recorded in the plan.

## Gemini

1. **Process-tree depth under shellper.** Accepted, verified at `pty-session.ts:979` (`pid` is `shellperPid` for shellper-backed sessions). Phase 4 now walks the tree by shape: shellper → loop → agent for builders, shellper → agent for architects, `session.pid` as the PTY child for direct sessions. Architects are also not alive when the shellper has no child. The tests cover both shapes.
2. **Resumed architects bypass `buildArchitectArgs`.** Accepted, verified at `tower-utils.ts:421-434` (the resume branch returns `env: {}` and its own args). Phase 6 applies the injection to every `resolveArchitectLaunch` return, including resume and its fallback, plus the direct `buildArchitectArgs` callers. Test 7 enumerates every form.
3. **Dropped sessions are filtered out before projection.** Accepted in part:
   - Builders: accepted. Phase 5 projects over every `data.builders` entry, not inside the `entry.builders` loop, which `continue`s on a missing session. A registered builder with no session is served `dead`.
   - Architects whose registry entry is deleted on permanent exit: not changed. The spec's iteration-1 disposition (Codex point 3) already scoped that out. Restart wait is served `dead`, and an architect removed from the registry leaves the overview as today. The plan states this scope explicitly. `liveArchitects` gains the workspace path.
- **Minor points, all accepted:**
  - `since` comes from `agentState.since`;
  - `urgencyBucket` and `compareAttention` use builders plus architects;
  - the reporter fragment goes on `baseCmd`, with its env merged unconditionally;
  - the row badge uses `agentState.since`.

## Codex

1. **Dropped architects.** Answered as Gemini point 3: scoped out by the spec, and now stated in the plan.
2. **The store must emit on every material change.** Accepted. It emits on activity, `activityAt`, `backgroundWork` or needs-input detail changes.
3. **Tower port source.** Accepted. Tower sets `CODEV_TOWER_PORT` to its own port on every agent session it creates; the reporter defaults to 4100. The hook command stays byte-identical across agents and ports.

## Claude

1. **Architect resume path.** Accepted, as Gemini point 2. The no-Tower `afx architect` is excluded deliberately: there is no registered agent to report for.
2. **Two builder id spaces.** Accepted. One key everywhere: the lowercased role id that `discoverBuilders` computes (the stored `builders.id`, else derived), equal to the `entry.builders` key. The resolver returns exactly that.
3. **Project over `data.builders`.** Accepted, as Gemini point 3.
4. **Tower port.** Accepted, as Codex point 3.
5. **The classifier omits `blocked`.** Accepted. The return includes `'blocked'`, and surfaces keep their gate path for it.
6. **`!atGate` suppresses needs-input for gated builders.** Not changed: this is the spec's precedence. A pending gate projects `blocked`, which outranks reported activity, and the plan now states it as intended.
7. **`WaitingItem.since`.** Accepted.
8. **`phase` vs `protocolPhase`.** Accepted. `b.phase` in both core and sdk.
9. **Normalize both sides.** Accepted.
10. **Dual-form convention.** Kept as one method returning `{ args, scriptFragment, env }`, following `buildResume`'s single-method dual form. The justification is now written into the plan.
11. **`NeedsAttentionList.tsx`.** Accepted: added to Phase 7.
12. **Launch-script byte identity.** Accepted. The Claude script's byte-identity tests are updated deliberately; session-less harness scripts stay byte-identical.
13. **Shared `~/.agent-farm/hooks/` across installs.** Accepted. The compatibility invariant is stated: a stateless script; a newer script against an older Tower is rejected and fails open, never producing a wrong state.


### Iteration 2 Reviews
- gemini: APPROVE — All Iteration 1 review findings have been thoroughly addressed and verified against the codebase; the plan is complete and ready for implementation.
- codex: COMMENT — The plan is technically sound and addresses prior review findings; only minor Phase 7 wiring and validation-gate details remain.
- claude: REQUEST_CHANGES — Well-verified plan with accurate file targeting, but the builder-key definition is factually wrong against `storedRoleId` (silent never-served state), the `atGate` rebuttal misses `prReady`, and Phase 4/6 need census reuse and injection-idempotence fixes.

### Builder Response to Iteration 2
# Plan 1595, iteration 2: rebuttal and disposition

Verdicts: Gemini APPROVE, Codex COMMENT, Claude REQUEST_CHANGES. All points were verified in the code and accepted.

## Claude

1. **Builder key.** Accepted, verified at `overview.ts:664-668`: `storedRoleId` keeps the stored id only for the `builder-`/`worktree-` shape. The key is now `storedRoleId(row) ?? worktreeNameToRoleId(dirName)`, extracted to one shared function. The resolver shares only the row matcher with `send.ts`, never its returned `row.id`. It is null-returning; `send.ts` keeps its throwing #1094 wrapper.
2. **`prReady` suppression.** Accepted, verified at `builder-helpers.ts:140/152`. A served `needs-input` or `dead` on a `prReady` builder is listed in `waiting`. `idle` and the PTY path stay suppressed for `prReady` as today. The porch-gate case still projects `blocked`.
3. **Census.** Accepted. Liveness uses `listProcessCensus()` (#1227) with the husk-sweep childless predicate and `census` seam. `census.length === 0` means unknown (`alive: null`, no confirmation counted), so a failed `ps` cannot mark the fleet dead.
4. **Double injection.** Accepted, verified at `tower-utils.ts:400/423/438`. The injection lives in `buildArchitectArgs` plus the single resume primary return. Reaching the no-Tower `afx architect` is noted as harmless: no identity, so nothing is sent.
5. **Lookup cost and `liveArchitects` callers.** Accepted. Lookups use Tower's `getGlobalDb()` handle behind a memo, never a new connection per report; both `liveArchitects` callers are updated.

## Codex

- `WorkView.tsx` (passes architects to `NeedsAttentionList`) and the contextual panel webview `main.ts` are added to Phase 7.
- The grep gate is qualified to agent-attention logic; `OpenFilesShellsSection.tsx`'s utility-terminal threshold is out of scope.

## Gemini

- APPROVE, no issues.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
