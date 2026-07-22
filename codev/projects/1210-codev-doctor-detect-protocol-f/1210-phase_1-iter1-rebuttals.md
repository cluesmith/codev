# Phase 1 (implement) iteration 1 — Rebuttals

**Verdicts**: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES

## Codex — Issue 1 (blocking): re-implements skeleton enumeration instead of reusing `listSkeletonFiles()`

> `protocol-drift-audit.ts` reimplements skeleton traversal via `collectFrameworkFiles()` instead of
> using `listSkeletonFiles()` from `lib/skeleton.ts`. That conflicts with the phase-1 deliverable and
> the spec constraint to reuse the existing resolver primitives so the audit and resolver stay
> aligned. Please switch enumeration to `listSkeletonFiles(subdir)` and keep the `.md`/`.json`
> filtering on top of that.

**Accepted — fixed.** I had added a custom `collectFrameworkFiles()` walk (with an injectable
`skeletonDir`) to ease unit testing. That was an unnecessary deviation: the spec and plan both list
`listSkeletonFiles` among the resolver primitives to reuse, and reusing it is what guarantees the
audit's notion of "the skeleton" is byte-identical to the resolver's.

Changes:
- Removed `collectFrameworkFiles()` and the `skeletonDir` parameter from `auditProtocolDrift()` and
  `hasFrameworkShadows()`.
- Added a small `skeletonFrameworkFiles(sub)` helper = `listSkeletonFiles(sub)` filtered to the
  `.md`/`.json` framework extensions (the "keep filtering on top" Codex asked for). Both public
  functions now enumerate through it.
- `getSkeletonDir()` is still used only to build the absolute skeleton path for hashing — consistent
  with `listSkeletonFiles`, which walks that same dir.

Testability is unaffected: `workspaceRoot` remains injectable, so unit tests build a temp workspace
with `.codev/` / `codev/` copies and diff them against the **real** installed skeleton (copy a real
skeleton file verbatim → `identical`; mutate one byte → `differs`). No injectable `skeletonDir` is
needed.

`tsc --noEmit` clean (0 errors) after the change.

## gemini / claude
Both APPROVE. Gemini specifically endorsed the raw-byte comparison decision; no changes requested.
