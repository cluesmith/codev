# Phase 2 (render-gate) — Rebuttal to iteration-1 review

## Verdicts
- **Gemini: APPROVE (HIGH)** — no issues.
- **Claude: APPROVE (HIGH)** — all deliverables present; two non-blocking observations.
- **Codex: REQUEST_CHANGES (HIGH)** — two points. Both are correct and grounded in the plan text; both **fixed** below (no disagreement).

---

## Codex point 1 — missing `claude-picker` fixture
**Agreed; fixed.** The plan's Phase 2 fixture matrix lists picker for *both* claude and codex (Deliverables + Acceptance Criteria: "idle/draft/menu/picker/wrapper/boot"), but only codex had one.

- **Added** `packages/codev/src/agent-farm/__tests__/fixtures/gate/claude-picker.busy.txt` and wired it into the required-states assertion (`render-gate.test.ts`).
- **What it is:** a *synthesized* claude `/model` picker. It is synthesized for the same reason `claude-idle` is — the sandbox `claude` binary is the `ez-cli` proxy shim, so there is no real claude picker to capture (documented in the fixtures README).
- **Why it is a real guard, not filler:** its highlighted row begins with the **same `❯` glyph** claude uses for the composer marker, and model names render normal-intensity. It pins that a picker's selection-cursor `❯` + list classifies **busy** via the `user-text` path — the marker matches the cursor, the model names count as occupancy — and is *never* mistaken for an empty composer (a false-clean would be a misdelivery). This mirrors the **real** `codex-picker` capture, whose `› 1. …` selection cursor exercises the identical path.
- **Result:** classifies busy; suite is now **23/23** (was 22).

## Codex point 2 — performance assertion too loose (500 ms vs the spec's ≤~50 ms)
**Agreed the 500 ms ceiling did not validate the phase's acceptance criterion; fixed.** Replaced the single cold-run `< 500 ms` assertion with **warm-up + best-of-5 `min` `< 75 ms`**.

- **Why best-of-N min:** a single cold run folds in JIT/first-parse/GC/scheduling noise. Measured here: **42.7 ms cold** vs **14.5 ms native steady-state** — the cold run is ~3× the real cost. The `min` over N runs strips those outliers and approximates the classifier's steady-state compute cost, which is the stable basis a budget assertion needs so it *validates the bound* instead of flaking.
- **Measured budget evidence (logged by the test):** best-of-5 under vitest = **19.2 ms**; native node = 14.5 ms; spike = 22 ms @ 1 MB. All comfortably inside the spec's ≤~50 ms seed-cap bound.
- **Why the ceiling is 75 ms, not 50 ms:** 75 ms is the *assertion ceiling for CI-noise tolerance*, not a claim the code runs near it — the logged 19.2 ms is the actual budget evidence. The protocol explicitly forbids introducing flaky tests; a literal `< 50 ms` on hardware that measures 42.7 ms cold (and on slower/shared CI runners) would flake. 75 ms still catches a catastrophic (e.g. O(n²) / hundreds-of-ms) regression on this safety-critical gate and is **5× tighter** than the prior 500 ms.

---

## Bonus fix found while grounding the perf measurement — latent CJS interop bug
While measuring against the **compiled `dist` under native node** (the production runtime — the package is `type: module` and its bins run compiled `.js`), I hit a latent bug not visible to the test suite:

- `@xterm/headless` resolves to its **CommonJS** entry (it has no `exports` map and no `type: module`), and its named exports are not statically analyzable, so `import { Terminal } from '@xterm/headless'` throws **"Named export 'Terminal' not found"** under native-node ESM.
- It was **masked by vitest** (vite's CJS interop makes the named import work in tests) and **dormant** because render-gate is unreferenced until Phase 4 — but it would have bitten Phase 4 at wire-up.
- **Fixed** to the default-import form — the codebase's own convention for CJS deps (`import Database from 'better-sqlite3'`) — plus a `import type { Terminal as HeadlessTerminal }` alias for the one type-position use (type-only → erased at compile time, so it adds no runtime import). Verified working under native node; `tsc --noEmit` clean.

---

## APPROVE reviewers' non-blocking notes (acknowledged)
- **Claude:** `RING_SEED_MAX_BYTES` is currently defined in `render-gate.ts` while the production seed cap originates in `tower-terminals.ts`. Agreed these should be reconciled (import from one place) when the gate is wired in **Phase 4**; left as-is for Phase 2 since the module is unreferenced. Noted for Phase 4.
- **Claude:** `claude-idle` being synthesized is the correct tradeoff (validates the classifier against real-claude SGR attributes, not the shim's atypical output). No change.

## Verification (post-fix)
- `render-gate` suite: **23/23 pass** (added claude-picker).
- `tsc --noEmit`: **clean** (exit 0).
- perf best-of-5: **19.2 ms** (logged).
