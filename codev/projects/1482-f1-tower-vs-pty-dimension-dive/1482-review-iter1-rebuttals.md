# PIR #1482 — Response to the iteration-1 consultation

**Verdicts:** gemini `APPROVE` (`KEY_ISSUES: None`) · codex `REQUEST_CHANGES` (HIGH) ·
claude `REQUEST_CHANGES` (HIGH).

**Nothing was rebutted. Every finding was accepted and fixed** in `e24f2a191`. Codex and
Claude independently identified the same top defect, which is the strongest signal in the set —
I treated the agreement as decisive rather than looking for a way around it. Each claim was
verified against the source before I acted on it; none was taken on the reviewer's word.

PIR is single-pass, so none of this is re-reviewed by a model. The human at the `pr` gate is
the only remaining check on these dispositions.

---

## 1. `setHeldVerdict` wrote unconditionally — ACCEPTED, FIXED

*Raised by: codex and claude, independently. Claude verified empirically against better-sqlite3
that a no-op rewrite returns `changes: 1`.*

**Confirmed at the source.** `db/mailbox.ts` ran a bare
`UPDATE ... WHERE id = ? AND status = 'held'` with no change predicate. The changed-only guard
existed only at the two call sites in `mailbox-delivery.ts` (`:584`, `:630`), while the plan,
the review file and my new `arch.md` text all credited the *repository function* with it.

**Why I did not argue "no live bug, docs are close enough".** There is no live bug — the
delivery pass does guard, and that would have been an easy rebuttal. It would also have been
wrong. The owner starvation notice reads elapsed time off `updated_at` to say how long a
composer has been occupied. A future caller that re-writes an unchanged verdict on every tick
resets that clock and the notice never fires — and that caller would have been reading
documentation stating the repository already protected them. Correct behaviour paired with
documentation naming the wrong layer is worse than no documentation.

**Fix:** the predicate now lives in the SQL.

```sql
UPDATE mailbox SET reason = ?, detail = ?, updated_at = ?
 WHERE id = ? AND status = 'held' AND (reason IS NOT ? OR detail IS NOT ?)
```

`IS NOT` rather than `<>` because both columns are nullable and `NULL <> NULL` evaluates to
NULL, not false — a `<>` predicate would let a `null` → `null` no-op through and bump the
timestamp anyway. That is not hypothetical: it is exactly the `no-live-pty` re-hold path.

**Pinned by 6 new tests** (`send-delivery.test.ts`) that drive `setHeldVerdict` directly, past
the call-site guards: repeated pair does not bump; repeated *null* detail does not bump (the
case that pins `IS NOT`); changed detail alone bumps; changed reason alone bumps; dropping a
detail to null bumps; terminal rows and unknown ids are untouched and return false. Call-site
guards kept as defence in depth. `arch.md` corrected to describe where the guard actually is.

## 2. The dashboard revert rested on a false premise — ACCEPTED, RETRACTED, VERIFIED

*Raised by: codex.*

Codex was right and I was wrong. I had reported "Playwright is not installed"; it is:

- `npx playwright --version` → `1.62.1`
- `@playwright/test ^1.58.0` **and** `playwright ^1.58.0` declared in `packages/codev/package.json`, with a `test:e2e:playwright` script
- browser binaries cached: `chromium-1217`, `chromium-1228`, two headless shells, `firefox-1532`
- `apps/web` has a plain `"dev": "vite"`

The missing `worktree.devCommand` blocks `afx dev` and nothing else. My error was checking
`node_modules/.bin` at the root of a **pnpm** monorepo, where package bins do not live, and
reading `npx`'s auto-fetch as proof of installation.

This matters beyond the finding: the revert was pre-authorized **conditionally** on browser
verification being infeasible. The condition was false, so the authorization never applied.

**Fix:** restored the `HeldCountBadge` render and the ported `formatHoldVerdict` (ported, not
imported — `apps/web` must not import from codev-core, invariant #1189), added 4 formatter
tests and 5 component tests, and drove it in **real chromium**: 6 e2e tests, captured verbatim
in the evidence file §9b, against a throwaway Tower on port 14100.

On rendering fidelity, which I was asked to report honestly: the popover does **not** truncate
or wrap differently from the CLI. `afx inbox` clips its REASON cell at 20 characters, so
`busy:no-composer-marker` appears there as `busy:no-composer-ma…`; the popover has no column
budget and renders it in full. Different available width, same sub-code.

## 3. Resize regression coverage was incomplete — ACCEPTED, FIXED (all three parts)

*Raised by: codex.*

All three sub-claims verified true.

- **`pty-manager.test.ts` did not cover the dropped resize.** It had only the happy path
  (`:40`) and unknown-id → null (`:47`). Since `resizeSession` returns `null` for *both* "no
  such session" and "the resize never landed", nothing in the suite distinguished them — which
  is precisely the ambiguity that forced the REST existence check to exist. Added a test that a
  dropped resize returns null **and leaves the session's dims unmoved**.
- **No test asserted 409 vs 404.** The only 409s in the suite were unrelated (`AMBIGUOUS`,
  cron). Added three route tests: 409 `RESIZE_DROPPED` for an existing session whose resize was
  dropped (asserting the body does *not* say `NOT_FOUND`), 404 `NOT_FOUND` for an unknown id
  (asserting it does *not* borrow `RESIZE_DROPPED`), and 200 with the **applied** dims on
  success — the last one pinning the old 200-echoing-requested-dims behaviour as gone.
- **The attach test faked the WELCOME getters.** It supplied `welcomeCols`/`welcomeRows` via
  `Object.defineProperty` on a fake emitter, which proves what `PtySession` does with the pair
  but never that `ShellperClient` hydrates it from a frame. Added 16 tests driving a real
  handshake through `miniShellper`: hydration of the 139×63 divergence case, both-or-neither
  atomicity across 11 malformed shapes, the 10 000 boundary, a legacy WELCOME omitting geometry
  entirely, and — the case a scripted edit got wrong during implementation — independence from
  the #1475 identity pair in both directions.

## 4. Minor findings — ACCEPTED, all three fixed

*Raised by: claude.*

- `apps/web/__tests__/HeldCountBadge.test.tsx`'s `row()` fixture omitted the now-required
  `HeldMessage.detail`. Latent rather than breaking because `apps/web`'s tsconfig `include` is
  `["src", "vite.config.ts"]` — the tests are not typechecked. Added, with a comment saying why
  it is easy to miss.
- The comment in `tower-routes.ts` `holdAndRespond` had been orphaned from the `detail: null`
  it explains by a blank line, reading as though code had been deleted. Moved onto the line.
- `inbox.ts`'s truncation example said `busy:no-composer-m…`. Ran `truncate(text, 20)`: it
  yields `busy:no-composer-ma…`. Corrected.

## 5. "The worktree is mutating mid-review" — ACCEPTED, fair, and resolved

*Raised by: claude.*

Correct, and it was me: I was fixing finding 1 while Claude was reading. Claude's 157-test run
therefore validated the working tree rather than HEAD. Resolved by committing everything in
`e24f2a191`; the suite figures in the review file are from that final tree. Worth avoiding —
reviewing a moving tree costs the reviewer real effort re-deriving state.

---

## Something neither reviewer caught, disclosed anyway

The first runs of my new browser test silently pointed at **port 4100 — the user's live
Tower**. The repo's `playwright.config.ts` defaults `TOWER_TEST_PORT` to 4100 with
`reuseExistingServer: true`, and my scratch config set the port only in `webServer.env`, which
is the *server* process's environment and not the *test runner's*. So the runner took the 4100
default while a correctly isolated Tower idled on 14100.

It was read-only and provably harmless — every `/api/*` route the test reads was mocked
in-page, it only navigated and clicked a popover, and the live `~/.agent-farm/global.db` mtime
is unchanged at `Aug 22 14:30`, checked after the run. But that is luck, not design: I built
the isolation and then never asserted the isolation was in effect. The symptom was quiet and
confusing rather than loud — a rendered `title` string that exists nowhere in `apps/web` — and
I spent several rounds theorising about stale bundles and hydration races before checking
`page.url()`, which would have answered it immediately.

The committed test now **throws when `TOWER_TEST_PORT` is unset** rather than defaulting to
4100. Recorded in the evidence file §9a and in `lessons-learned.md`.

## Test results on the final tree

- `packages/codev`: **278 files passed / 3 skipped; 5521 passed / 48 skipped** (from 5495; +26)
- `apps/web` (**not** covered by root `pnpm test`, which is `--filter @cluesmith/codev`):
  **33 files, 381 passed / 1 skipped**
- Playwright, real chromium, throwaway Tower on 14100: **6 passed**
- `pnpm build`: exit 0
