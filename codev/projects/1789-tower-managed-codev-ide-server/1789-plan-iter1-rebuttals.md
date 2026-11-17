# Plan iteration 1: responses to 3-way review

Verdicts: gemini APPROVE, codex REQUEST_CHANGES, claude REQUEST_CHANGES. All points accepted and folded into the plan.

## Lock re-entrancy / deadlock (codex, claude, gemini note)
Accepted. Verified: `spawnIdeServer` calls `stopIdeServer` on a port change, `ensureIdeServerLive` calls `spawnIdeServer`, and boot reconcile is fire-and-forget (tower-server.ts ~L789). Plan now: non-reentrant lock acquired only at three entry points (API POST, API DELETE, respawn body); unlocked inner functions; record re-read inside the lock; completion tests for the port-change and reconcile paths; the concurrency test forces the spawn path.

## CLI 30 s timeout vs preflight budget (codex, claude)
Accepted. Timeouts become exported constants in ide-version.ts with a derived `IDE_START_BUDGET_MS`; `towerIdeRequest` uses it for POST/DELETE; tests assert the tie and that a >30 s Tower answer does not trip the client.

## Prerelease comparison (codex)
Accepted: a suffix on line 1 is now refused as unparseable instead of ignored, keeping semver ordering honest. The npm package suffix is never read, as before.

## Build blast radius (claude)
Accepted. Risk row covers all five CI builds; `CODEV_SKIP_IDE_EXTENSION=1` escape hatch for dev loops and non-packaging CI jobs; Package Install Verification builds the full shape and verify-install fails a vsix-less tarball.

## Skill copies parity wording (claude)
Accepted and verified (root and skeleton afx SKILL.md differ: 10750 vs 9471 bytes). Reworded to parity within each pair.

## Minor (claude, gemini)
All accepted: Scenario 16 spawn-proceeds criterion in phase 4; null prior record gives restartRequired; adopt does not record a serverVersion from a different binary; floor/engines coupling sentence in arch.md; case-insensitive id match; explicit chmod 0700 after mkdir.
