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


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
