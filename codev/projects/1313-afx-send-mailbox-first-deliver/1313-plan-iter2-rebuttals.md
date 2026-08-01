# Spec 1313 — Rebuttal to iteration-2 plan consultation

**Verdicts**: Gemini APPROVE · Codex REQUEST_CHANGES · Claude APPROVE — all HIGH confidence.

Gemini and Claude both APPROVE, having independently verified that every iteration-1 fix landed and that the
plan's file paths/line numbers are accurate against the worktree. Codex raised three deeper *implementation-seam*
concerns; I **verified all three against the actual code and accepted all three** (no disputes). No phase scope
changed — the edits name previously-implicit seams so each phase is concretely implementable.

## Codex (REQUEST_CHANGES) — all three accepted, all verified against code

1. **Dead-session persistence not implementable as written.**
   **Verified & fixed.** `resolveTarget` (`tower-messages.ts:152`) resolves only against live
   `getWorkspaceTerminals()` (lines 215/252/302); `handleSend` 404s at the no-live-PTY check
   (`tower-routes.ts:1479-1486`) before it can persist. So "hold `no-live-pty` and deliver on respawn" was not
   reachable. Added a Phase 4 deliverable: an **agent-registry fallback** (resolve a known agent from the
   global.db `builders`/`architect` registry via `state.ts` when no live terminal matches) plus a **`handleSend`
   restructure** so a resolved-but-no-live-PTY target persists a `no-live-pty` held row instead of 404ing.
   Good catch — this is what makes the dead-session success criterion achievable.

2. **Phase 2 omits the `resolveProfile(session)` metadata seam.**
   **Verified & fixed.** `PtySession` exposes only `label`/`cwd` publicly; `command`/`args` are private
   (`pty-session.ts`). Added a Phase 2 deliverable to expose the app identity (a `get command()`/`get launchArgs()`
   getter, or an `appProfileKey` recorded at spawn), and cross-referenced it from the app-detection note. This is
   the concrete source `resolveProfile` needs.

3. **`afx send --all` would keep misreporting held sends as "sent."**
   **Verified & fixed.** `sendToAll()` (`send.ts:200`) pushes to `results.sent` on any `result.ok` (line 232),
   ignoring held/reason. Extended the Phase 4 client-contract deliverable to cover **both** the single-send path
   (`:332`) and the `--all` path (`sendToAll()`): report `delivered` vs `held (<reason>) — id <id>` per target and
   aggregate held/delivered counts for `--all`.

## Claude (APPROVE) — two cosmetic notes, both handled

1. **`GLOBAL_CURRENT_VERSION` is in `db/index.ts`, not `schema.ts`.** Correct — and the Phase 1 migration
   deliverable already targets `index.ts` for the version bump (the `schema.ts` reference is only for adding the
   table to `GLOBAL_SCHEMA`). No change needed; noted in the Expert Review for the builder's clarity.
2. **`tower-client` existing return shape is `{ok, resolvedTo, error}`, not `…terminalId`.** **Fixed** — the Phase 4
   deliverable now says "add `held`/`reason`/`mailboxId` alongside the existing `ok`/`resolvedTo`/`error`."

## Net

Three real implementation-seam gaps closed with named files/lines; two cosmetic descriptions corrected. Two of
three reviewers already APPROVE with full file-reference verification; the Codex seams are now addressed. Phase
count and scope unchanged (9 phases).
