# Builder thread — air-1383

## 2026-08-10 — Implement

AIR (strict) for issue #1383: add `streamdeck` to the `area/` vocabulary in the
`## Issue labels` section of CLAUDE.md and AGENTS.md.

- Applied the exact insertion from the issue between `web` and `core`, with the
  parenthetical clarification, rewrapped to the file's prevailing width.
- Verified `diff CLAUDE.md AGENTS.md` → byte-identical.
- Verified `grep -rn "cross-cutting" codev/resources/ codev-skeleton/` → no other
  file carries the codev-specific area list (hits are generic skeleton guidance
  and unrelated prose, exactly as the issue anticipated).
- Purely declarative docs change → no new tests written (per AIR implement
  prompt's allowance for declarative changes). Ran full `pnpm build && pnpm test`
  anyway to satisfy phase checks.
- Committed as `[Air #1383] docs: add area/streamdeck to the area-label vocabulary`.

No surprises, no blockers.
