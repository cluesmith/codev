# Phase 5 — rebuttal to iteration-1 review

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 3 | 3 | 0 |
| Claude | (verdict pending at fix time) | — | — | — |

## CX-1 — `includes()` cannot enforce byte-identical replication

**Accepted, and the attack shape is worth naming**: an appended qualifier —
*"…stage each file explicitly by path, unless convenient."* — contains the
canonical substring and passes `includes()` while gutting the rule. My benign
parentheticals (relay-convention note, porch-context exception) were the same
mechanical shape as that attack, so the enforcement couldn't distinguish them.

**Fixed with line-exactness**: some line on the surface must *be* the canonical
wording, allowing only a list prefix (`- `, `4. `) and bold markers. All
contextual notes moved to their own adjacent lines (4 porch skill copies,
CLAUDE/AGENTS afx-from-root exception, maintain.md's inline sentence).

One consequence, documented in the registry rather than hidden:
`arch-critical.md` carries the status.yaml sentence inside its combined porch
fact, and the hot tier's ≤10-fact cap forbids splitting it onto its own line —
so arch-critical is deliberately **not** listed under `no-hand-edit-status`.
Its wording remains policed by the stale-variant sweep and the hot tier's own
MAINTAIN regime (Spec 987). (R1's arch-critical line is already line-exact and
stays listed.)

## CX-2 — `maintain/protocol.md` carried the canonical but was unregistered

**Accepted** — I converged its wording in the sweep and then failed to register
the file, exactly the "enforcement misses a surface" gap M5 exists to close.
Registered.

## CX-3 — `git clean -f` vs the ratified `-fd`

**Accepted.** The spec's ratified list says `git clean -fd`; my canonical wrote
`-f`. Phase 5 freezes the form, so the frozen form must match the ratification
byte-for-byte. Fixed in the registry and both root docs.

Suite: 3,734 passed, 0 failures (manifest re-pinned for the one intentional
line-split in maintain.md).
