# pir-1497 — open-architect must not substitute a different architect while claiming to be `main`

Issue #1497 · area/vscode · PIR (plan-approval, dev-approval, pr gates; Amr owns all three).

## Plan phase (done, awaiting plan-approval)

Wrote `codev/plans/1497-vscode-open-architect-silently.md`.

**Root cause** (`extension.ts:920-924`): `const fallback = targetName === 'main' ? architects[0]
: undefined` opens `architects[0]` but flows the requested name `'main'` onward. In
`terminal-manager.ts` the name is an address twice: the cache key `architect:${name}` (:123) and
the `injectArchitectText` lookup (:152). So web's terminal caches under `architect:main`, gets the
unqualified "Codev: Architect" label (:135), and later `injectArchitectText(text,'main')` types
into web. Self-corrects only on the next press.

**Key insight driving the recommendation:** the fallback has NO healthy execution path — it is only
consulted when `match` is undefined, i.e. when `main` is absent. Every real execution is the failure
window. Removing it costs nothing legitimate.

**Design decision — REFUSE, deliberately NOT diverging from sibling lane pir-1494.** Kickoff asked me
to make the substitute-vs-refuse choice deliberate (1494 refuses for the approval relay; kickoff/main
leaned that terminals *may* differ because opening one is recoverable). I tested that and concluded
they should NOT diverge: recoverability makes refuse cheap but gives no positive reason to substitute;
caller intent + no-healthy-path + convention-convergence + Amr's issue comment ("refuse is strictly
better for the deck") all point to refuse. Recorded in the plan.

**Two-part fix:**
- Part A (structural): pass `target.name` (resolved occupant) to `openArchitect`, not the requested
  `targetName` — holds the invariant under ANY policy, future-proof.
- Part B (policy): `resolveArchitectTarget` = `architects.find(...)`, no fallback → refuse + existing
  warning. Option B (substitute under own name/label) kept as a documented ONE-LINE switch for the
  gate, because Part A makes it safe.

**Files:** `extension.ts` (resolver + call site), `terminal-manager.ts` (no behaviour change; invariant
surface). New test `__tests__/open-architect-not-live-main.test.ts`. Scope guard honoured — no
approve.ts / role docs / protocol prompts / types / Tower.

**Test strategy (honest scope split, per kickoff's "resolver assertions prove nothing" bar):**
- Headless behavioural (builder shell): (1) injection-capture — real TerminalManager + seeded fake
  terminal, assert `injectArchitectText(ref,'main')` returns false + recorder untouched, reaches web
  only when addressed 'web'. Real sendText capture, not a resolver spy. (2) resolve-refusal on the
  pure helper. (3) call-site invariant guard (feasibility to confirm in implement).
- Human-machine (dev-approval manual): live-Tower + VSCode-UI round-trip (main down → warning + no
  terminal → referenceIssueInArchitect lands nowhere; main up → lands in main). Named explicitly
  because a real openArchitect dials a Tower pty — cannot run headless.

**Open item to confirm in implement:** whether the pure helper can live/export in `extension.ts` and
be vitest-importable (deep import graph; nothing imports extension.ts in __tests__ today). Fallback:
tiny new `apps/vscode/src/open-architect.ts` — will flag before adding a third file.

## Implement phase (done, awaiting dev-approval)

Confirmed extension.ts is NOT vitest-importable (78 imports, deep value-import graph). Took the
flagged contingency: new `apps/vscode/src/open-architect.ts` holding `resolveArchitectTarget` (no
fallback) + `openResolvedArchitect` (flows the occupant's own name onward, refuses non-live main).
extension.ts command is now a thin adapter over it; added an invariant comment in terminal-manager.ts
at the openArchitect cache-key line.

**Harness note (matters for reviewer):** the injection-capture test DOES import the real
TerminalManager and captures real `sendText` — this only resolves because CI's test.yml runs
`pnpm build` before vitest (codev-types/sdk `dist` must exist). Locally I had to build
codev-types + codev-sdk (+ artifact-canvas for the pre-existing webview check-types) first. The
existing terminal-manager.test.ts avoids importing TerminalManager for this reason; my test is the
first to import it, relying on the build-first ordering.

**Pre-existing (NOT mine):** `check-types` webview step fails on `@cluesmith/codev-artifact-canvas`
missing dist unless that package is built first (CI builds it in a dedicated step). Untouched file.

Commits: fix (open-architect.ts + extension.ts + terminal-manager.ts), tests (new test + updated
extension-architect-commands source guard for the delegation). Full suite: 856 pass, check-types
green (after building deps), lint clean, esbuild bundles.

**Dev-approval demo needing the human's machine** (a real openArchitect dials a Tower pty; can't run
headless): workspace with `web` + `main`, stop main → open-architect(main) shows the warning + no
terminal, referenceIssueInArchitect lands nowhere (not in web); main up → both land in main. Option-B
switch (if reviewer prefers) is one line in resolveArchitectTarget.
