# Phase 4 iter3 rebuttal

Verdicts: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES.

## Codex

1. **Every symlink hashed as `<special>`, so retargeting one is invisible.** Accepted; fixed.
   `hashPath` now records a symlink as `<link:TARGET>` (from `readlink`), so a retargeted
   link differs in both the git and the non-git snapshot (and in consult's tripwire, which
   shares it). New test: `reports a retargeted symlink`.

## Claude (APPROVE, cosmetic notes)

- `report.scope` contradicted `detectionLost`: fixed; the scope line is omitted when the
  post-session snapshot could not be taken (the lost-detection line says why).
- A signal-terminated agent is exit-bearing even with valid drafts: intended. The spec makes
  the agent's own failure exit-bearing, and a killed session is one; the drafts are still
  kept and validated.
- The prompt file is written before the confirmation: intended, so a declined or failed run
  can point at it (both now do).
- An unwritten cold doc makes its hot map's validation noisy: left as is; the unwritten file
  is reported first and the map errors follow from it, which is accurate.
- Flaky `session-manager` test: will be raised with the architect for a tracking issue.
