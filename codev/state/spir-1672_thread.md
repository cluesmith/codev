# Builder thread: spir-1672 — Lane Card (#1672)

Protocol: SPIR (strict). Owning architect: architect:vscode.

## 2026-09-29 — Specify phase start

Now: reading sources of truth and drafting the spec for the per-lane status card.

- Spawned into the specify phase; no prior spec exists, so I author it from issue #1672 (amended 2026-09-10) + main's routing comment + the vscode architect's lane brief.
- Lane brief rulings (fixed): #1672 alone (companion #1674 not folded in; card must render with the last-ask field absent — first-class test); absorbs #1595 as ONE sdk-side ball-owner/attention-state module near pir-1566 `compareAttention`; data plane rides OverviewCache only (nothing spawns gh); design coexistence of the card row with a future #1729 park chip (don't build it); flag every contract-surface section (types/sdk/core/Tower endpoints) in the spec-gate message for routing to main; respect the pir-1566 file fence; `Now:` convention lands in both trees; spec/plan gates are the owner's alone.
- Kicked off a read-only exploration of OverviewCache, compareAttention/#1595, thread-file writes, porch status.yaml, Tower routing, codev-types, global.db/held messages, afx status/attach, and the #1049 VS Code panel to ground the spec.

### Grounding findings (from exploration)
- OverviewCache: `packages/codev/src/agent-farm/servers/overview.ts:866`; `getOverview()` returns `OverviewData`; staleness via `forgeStatus`/`forgeResetAt` + TTLs. **CI status is NOT cached today** — `OverviewPR` (api.ts:233) carries `reviewStatus`/`isDraft`/`reviewRequests` only. "CI 7/7" is a real design decision under the no-new-gh guardrail.
- Attention: `compareAttention` (#1566) and #1595's working/needs-input/idle/dead states DO NOT EXIST yet. Only bucket-based `deriveAttention`/`isIdleWaiting` in `packages/sdk/src/builder-helpers.ts`. This spec introduces the single sdk-side ball-owner state module and absorbs #1595.
- Thread files: freeform prose, no writer helper. `Now:` is a pure convention on existing writes (matches "no new write moment").
- status.yaml: `parseStatusYaml`/`ParsedStatus` at overview.ts:41-78; gate-requested = `gates[g]==='pending' && gateRequestedAt[g]`. Reusable: detectBlocked/detectBlockedGate/detectBlockedSince/GATE_LABELS.
- Tower routing: `tower-routes.ts` ROUTES table + `/workspace/:enc/*`; security choke `isRequestAllowed`→`isPublicRoute` (server-utils.ts:148). Card endpoint keyed-by-default: just don't add to isPublicRoute.
- Types: `LaneCard` → `packages/types/src/api.ts` (wire-only). global.db `~/.agent-farm/global.db`; held via `db/mailbox.ts`→`heldCount`. Terminal liveness = `lastDataAt`.
- CLI: `afx card` = new `.command('card')`+`commands/card.ts`; `afx status --cards` = option on existing status command (cli.ts:216).
- VS Code host: `apps/vscode/src/contextual-panel/` `ContextualPanelProvider` follows terminal focus, already renders `deriveAttention` as the Attention fallback. Card strip = new descriptor kind. (Not in the pir-1566 fence, but may need 1566 attention-format helpers — flag in plan.)
