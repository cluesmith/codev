# air-1779 thread

- Implemented #1779 across three surfaces: Stream Deck face glyphs (beaker/tools/search/library drawn in-plugin), dashboard `gateKindClass` (single neutral `attention-kind--other` for the four non-core gates), Tower hub attention rows.
- Tower hub: threading the canonical gate id was a fill-in, not a refactor — added `gateId: string | null` to the SDK `GateItem` (`builder.blockedGate ?? null`; `'pr'` for the prReady row), and `attentionRows` now keys on `gateIconFor`. `warning` stays only for a null id (older Tower without `blockedGate`).
- Gotcha: app vitest suites fail with "Failed to resolve entry for package @cluesmith/codev-types" until `pnpm build` runs in a fresh worktree; green after.
