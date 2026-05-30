# spir-945 — Builder Thread

**Project:** 945 — Build foundational reusable package `@cluesmith/codev-artifact-canvas`
**Protocol:** SPIR (strict mode, porch-driven)
**Branch:** builder/spir-945

---

## 2026-05-31 — Specify phase started

Picked up project 945 in strict mode. Porch reports phase = `specify`, iteration 1. No
spec file existed, so I'm authoring `codev/specs/945-build-foundational-reusable-pa.md`
from the (very detailed) issue body.

### Context gathered
- Monorepo: pnpm workspace, `packages/*`. Existing packages: `types` (tsc, ESM),
  `core` (tsc, ESM, multi-export), `dashboard` (React **19** + Vite 6 + Vitest),
  `vscode` (esbuild), `config`, `codev`.
- Dashboard is React 19 — informs the canvas peerDep range (`^18 || ^19`).
- Existing #857 review-marker convention lives in
  `packages/vscode/src/comments/plan-review.ts`. **Actual format is positional:**
  `<!-- REVIEW(@<author>): <text> -->` written on the line *after* the target line —
  there is **no** explicit `line=N` in the current convention. Regex:
  `/<!--\s*REVIEW\s*\(@([^)]+)\)\s*:\s*([\s\S]*?)\s*-->/g`.

### Open reconciliation flagged
The issue body states the marker form is `<!-- REVIEW(@author, line=N): text -->` and
calls it "the existing convention from #857". That's inaccurate — #857 is positional
without `line=N`. This matters for the "no regression to #857" AC. Resolution proposed
in the spec: the **package stays serialization-agnostic** (MarkerAdapter is an interface;
the host owns on-disk format). The VSCode host preserves the positional #857 form; the
explicit `line=N` form is an optional host enhancement, and `lineRange` is reserved for
future region anchors. Will surface this to the architect at the spec-approval gate.

## 2026-05-31 — Spec iter-1 consultation done

3-way consult (Gemini / Codex / Claude) all returned **APPROVE WITH SUGGESTIONS**, no
blockers. All three affirmed D3 (serialization-agnostic package) as the keystone and praised
the marker-format catch. Folded six convergent refinements into the spec: adapter error
semantics, 0-based `data-line`, subscription lifecycle (idempotent Disposable via useEffect),
change-coalescing is host's job, `examples/` excluded from published files, package source
avoids React-19-only APIs. See the spec's Consultation Log. Committing, then `porch next` to
advance toward the spec-approval gate — where I'll STOP and notify the architect (and raise
the marker-format wording fix).
