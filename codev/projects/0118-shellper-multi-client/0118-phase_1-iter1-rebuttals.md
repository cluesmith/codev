# Phase 1 Iteration 1 Rebuttals

## Disputed: clientType || 'tower' fallback violates spec requirement

Codex flagged `hello.clientType || 'tower'` at `shellper-process.ts:313/323` as a spec violation because `clientType` is marked "Required" in `HelloMessage`.

This fallback is intentional backward compatibility for rolling deployments. When Tower is upgraded before shellper (or vice versa), the old client won't send `clientType`. Defaulting to `'tower'` is the safe choice:

1. **Only Tower connects to shellper today** — there are no terminal clients yet (Phase 2 adds `af attach`). So any existing client without `clientType` IS a tower.
2. **Claude's review agrees** — Claude explicitly called this "good defensive coding" and "a pragmatic backward-compat choice."
3. **The TypeScript interface enforces the requirement at compile time** — any NEW code sending HELLO must include `clientType`. The runtime fallback only catches old/upgraded clients that predate the field.
4. **The spec's "Required" annotation is about the protocol going forward**, not about rejecting old clients during a transition window.

Rejecting HELLO frames without `clientType` would break Tower↔shellper connectivity during upgrades, which is worse than silently treating them as tower.
