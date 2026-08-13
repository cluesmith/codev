# PIR #1410 — Rebuttals to iteration-1 consultation

Verdicts: **Gemini APPROVE**, **Claude APPROVE**, **Codex REQUEST_CHANGES** (2 points).

## Codex point 2 — `feedbackMode` / `queuedFeedback` lack a reliable refresh trigger — ACCEPTED, FIXED

**Codex is correct.** I verified the refresh path against the code:

- The deck refreshes its overview on any SSE envelope (`store.ts` `onEnvelope → refresh()`).
- `status.yaml`/phase changes reach the deck because **porch broadcasts `overview-changed` after every mutating command** (`commands/porch/index.ts:1240`).
- Queue files are written by VSCode's `ReviewQueueStore`, which **never notifies Tower**, and Tower has **no watcher** on `pending-comments.json` or `.vscode/settings.json`. So `queuedFeedback` and `feedbackMode` had **no deterministic push** — the badge/label only refreshed when some unrelated SSE event fired, and the deck's refresh-on-command-echo could race ahead of the queue write (reading the stale, pre-write count). Both of Codex's failure modes are real.

**Fix** (`apps/vscode/src/review-queue/overview-nudge.ts`, wired in `extension.ts`): on the two out-of-band mutations — a `ReviewQueueStore.onDidChangeQueue` (covers deck enqueue, Send Fb flush, discard, and cross-window writes) and a `codev.diffCodelensMode` configuration change — VSCode calls `TowerClient.refreshOverview()`. That POSTs `/api/overview/refresh`, which invalidates Tower's overview cache **and broadcasts `overview-changed`** — the existing mechanism built for exactly "out-of-band mutations invisible until some other SSE event happens to fire" (`tower-client.ts:613`). It fires **after** the write, so the deck (and dashboard) re-fetch the fresh values deterministically, eliminating the race and the lag.

**Regression test** (`apps/vscode/src/__tests__/overview-nudge.test.ts`, 3 cases): a queue mutation nudges Tower; a `diffCodelensMode` change nudges it while an unrelated setting does not; and it's a no-op (no throw) when Tower is disconnected. These fail without the wiring. Full vscode suite green (825).

## Codex point 1 — `Codev.streamDeckProfile` not updated — REBUTTED (deliberate, human-approved on hardware)

Not a defect — a **deliberate, documented scope decision**, already reviewed and accepted:

- The profile has **always** shipped `Actions: null` (verified in git history: #1404 shipped Row 1 the same way). It is a device-model scaffold; adopters place keys themselves. There is **no known-good `sdProfile` Actions schema in this repo's history** to pre-populate from, and a hand-authored binary profile that fails to import would break at the exact moment (the hardware session) it matters — strictly worse than the valid blank.
- The primary workflow is **not** unshipped: it was verified on real SD+ hardware at the `dev-approval` gate, where the human placed the eight keys per the README's documented two-zone layout and exercised selection, dial-collect/flush, mode label, and the Row 2 palette. The plan was revised (with a visible note) and the review documents this under "Things to Look At."
- This is escalated to the human at the `pr` gate (they already ruled on it at `dev-approval`). A pre-populated importable profile remains a reasonable follow-up **iff** someone can verify the import on hardware first.

**Note on process:** PIR consultation is single-pass — neither point gets an independent AI re-review. Point 2's fix is backed by its regression test + the human's `pr`-gate review; point 1 is the human's call, already made once at `dev-approval`.
