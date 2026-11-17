# PIR #1482 — dev-approval evidence

Captured 2026-09-03 from **this worktree's build** (`.builders/pir-1482`), at commit `908dfaaad`.

**Isolation.** Everything touching a database ran with `NODE_ENV=test` and
`AF_TEST_DB=pir1482-evidence.db`, which redirects `getGlobalDbPath()` to
`~/.agent-farm/pir1482-evidence.db`. The live `~/.agent-farm/global.db` was never opened —
its mtime is still Aug 22. The temp database was deleted afterwards. No source file was
modified while gathering this; the tree was clean throughout.

**Labels.** `LIVE` = the real code executed and this is its actual stdout, pasted unedited.
`TEST OUTPUT` = a vitest run. Nothing here is reconstructed or prettified. Where output was
ugly — blank lines, truncated agent names in a fixed-width column — it is left ugly.

**One item could not be induced.** Item 3 is marked NOT INDUCED with the reason. It is the
only gap.

---

## 1. `afx inbox` — the compound REASON cell — LIVE

Driven through the real `/api/inbox` route (`handleInboxList`) over a real socket, rendered by
the real `inboxList()` CLI. The three rows' `reason`/`detail` were written by the real
`deliverAgentMail` delivery pass — not set by hand — from three different gate verdicts.

```
[info] Created new global.db at /home/user/.agent-farm/pir1482-evidence.db
### 1. afx inbox (real renderer, real /api/inbox projection) ###


Held messages (3)
─────────────────
  ID                                      AGE     REASON                FROM → TO               WORKSPACE     
  ────────────────────────────────────    ─────   ───────────────────   ─────────────────────   ───────────── 
  502b59d9-6ba3-4a4e-91e0-dd1a70850bd9    0s      busy:user-text        architect:main → pir-1  codev         
  11e85f32-8821-4f3f-90e3-624188231fcc    0s      busy:no-region-end    architect:main → pir-1  codev         
  a17d0fa8-c448-4c46-a3d7-3788a767f8ee    0s      busy:no-composer-ma…  architect:main → pir-1  codev         

[info] Show a message body: afx inbox show <id>   ·   Dismiss: afx inbox dismiss <id>

[db path] /home/user/.agent-farm/pir1482-evidence.db
[row ids] 502b59d9-6ba3-4a4e-91e0-dd1a70850bd9 11e85f32-8821-4f3f-90e3-624188231fcc a17d0fa8-c448-4c46-a3d7-3788a767f8ee
```

Notes on what to look at:

- All three gate details render. Only `busy:no-composer-marker` (23 chars) exceeds the
  20-wide column; it truncates to `busy:no-composer-ma…` with an ellipsis marking the cut,
  rather than silently shortening into something that reads like a different verdict.
- The `FROM → TO` and `WORKSPACE` columns are unchanged — `architect:main → pir-1` is the
  pre-existing 22-char truncation of that cell, not a regression from the REASON widening.
  (PR #1486 is separately de-truncating that column.)
- Header rules line up with the widened column.

## 2. `afx inbox show <id>` — the Detail line — LIVE

Through the real dispatcher (`handleRequest` → `handleInboxShow`) over a real socket.

```
### 2. afx inbox show 502b59d9-6ba3-4a4e-91e0-dd1a70850bd9   (detail=user-text) ###


Message 502b59d9-6ba3-4a4e-91e0-dd1a70850bd9
────────────────────────────────────────────
  Status: held
  Reason: busy
  Detail: user-text — a draft or menu occupies the composer; a human is at the line and delivery resumes when it clears
  From → To: architect:main → pir-1482-alpha
  Workspace: /home/user/code/codev_root/codev/.builders/pir-1482/packages/codev
  Created: 2026-09-03T18:26:34.015Z

Body
────
evidence body

### 2. afx inbox show 11e85f32-8821-4f3f-90e3-624188231fcc   (detail=no-region-end) ###


Message 11e85f32-8821-4f3f-90e3-624188231fcc
────────────────────────────────────────────
  Status: held
  Reason: busy
  Detail: no-region-end — the composer marker was found but nothing bounds the region below it (a partial frame, or dimensions that do not match the real terminal) — this will not clear on its own
  From → To: architect:main → pir-1482-bravo
  Workspace: /home/user/code/codev_root/codev/.builders/pir-1482/packages/codev
  Created: 2026-09-03T18:26:34.019Z

Body
────
evidence body

### 2. afx inbox show a17d0fa8-c448-4c46-a3d7-3788a767f8ee   (detail=no-composer-marker) ###


Message a17d0fa8-c448-4c46-a3d7-3788a767f8ee
────────────────────────────────────────────
  Status: held
  Reason: busy
  Detail: no-composer-marker — no composer marker on screen at all (a boot/wrapper screen, a drifted app profile, or an unrenderable frame) — this will not clear on its own
  From → To: architect:main → pir-1482-charlie
  Workspace: /home/user/code/codev_root/codev/.builders/pir-1482/packages/codev
  Created: 2026-09-03T18:26:34.022Z

Body
────
evidence body
```

## 3. The `afx send` held line — **NOT INDUCED**

**Why not.** `commands/send.ts:340` constructs `new TowerClient()` with no port, so the CLI can
only reach the live Tower on port 4100. That Tower is running and belongs to the user's real
session; pointing evidence-gathering at it would send real messages to real agents. I declined.

I also could not reach the gate-held branch through a stub server: `/api/send` resolves a real
terminal registry and a real PTY before it can produce a `busy` hold, and the isolated database
has neither. The attempt returned, verbatim:

```
HTTP 404
{
  "error": "NOT_FOUND",
  "message": "Workspace '/home/user/code/codev_root/codev' has no registered terminals."
}
```

**What covers it instead.** The exact source (`commands/send.ts:399-413`):

```ts
} else if (result.held) {
  logger.info(
    `Message held for ${result.resolvedTo ?? target} (${formatVerdict(result.reason, result.detail, 'pending')})` +
      `${result.mailboxId ? ` — mailbox id ${result.mailboxId}` : ''}. ` +
      `It delivers automatically when the prompt is clear.`,
  );
  // Issue #1482: a hold the gate could not classify will NOT clear on its own, so saying
  // "it delivers automatically" and stopping there would be misleading for exactly the
  // case that needs a human. Say so, once, only for that case.
  if (isUnverifiableVerdict(result.reason, result.detail)) {
    logger.warn(
      `The render gate could not verify that composer (${result.detail ?? result.reason}), ` +
        `so this hold will not clear by itself — inspect with 'afx inbox'.`,
    );
  }
}
```

At the reviewer's direction this branch is now covered by
`__tests__/send-hold-warning.test.ts`, which drives the real `send()` with a mocked Tower
client — see §7 below for that run.

## 4. The owner starvation notice, both branches — LIVE

Produced by the **real** `escalateHeldToOwner` (obtained via the real `makeDeliveryPorts`) driven
by the real `MailboxDrainer`, against a real registered architect. The bodies below were read
back off the mailbox rows the production code enqueued. Only two gate inputs were stubbed
(`getSessionForAgent`, `classify`), so that the verdict under test is the one intended.

```
### 4. detail=user-text  → the SAFE branch ###
Mailbox delivery is STUCK for builder 'pir-1482-occupied' @ codev. 1 message held ~1m (busy:user-text, re-confirmed across 5 consecutive gate checks). Its composer has been OCCUPIED that whole time — a draft or an open menu is on the line, which usually means a human is working there, and delivery resumes by itself the moment the line clears. Remedy: check with them first; 'afx inbox' inspects the queue, and 'afx interrupt pir-1482-occupied' clears the composer only if you are sure nobody is mid-thought.

### 4. detail=no-region-end → the DEFECT branch ###
Mailbox delivery is STUCK for builder 'pir-1482-unverifiable' @ codev. 1 message held ~1m (busy:no-region-end, re-confirmed across 5 consecutive gate checks). The render gate CANNOT VERIFY that composer — this is not a busy human, it is a classifier that cannot find a bounded composer region, so the mail will never deliver on its own. Usual causes: a drifted TUI profile, a torn/mid-repaint frame, or Tower's terminal dimensions diverging from the real PTY (Issue #1482). Remedy: 'afx inbox' to inspect; resizing the viewer forces a repaint; 'afx interrupt pir-1482-unverifiable' clears a stuck composer.
```

The old single body offered `afx interrupt` for every hold. In the first case above that is
advice to interrupt a human mid-draft. The streak (`re-confirmed across 5 consecutive gate
checks`) comes from the drainer's existing per-agent counter — no new state, no new column.

## 5. Dropped resize — the WARN, and dims that did not move — LIVE

Real `PtySession` and `TerminalManager` from the built dist. `console.warn` was not
intercepted; the bracketed lines are its actual output.

```
### 5. dropped resize: the WARN, and the dims that did NOT move ###

resize(139,63) with a LIVE socket  -> true
  session dims now : 139x63
  gate mirror dims : 139x63

resize(100,40) with a DROPPED write -> false
  session dims now : 139x63  <- unchanged
  gate mirror dims : 139x63  <- unchanged

--- the same drop through TerminalManager (the WARN caller) ---
resizeSession() returns       : null
resizeSession(unknown id)     : null
```

```
### 5a. the WARN emitted by the control-message resize path ###

[pty-manager] resize dropped for session 9fe28cab-e9d8-41ab-8b1c-129536d6164a: 100x40 not applied (no live process or dropped shellper write) — dimensions unchanged

  session dims after   : 80x24 (constructor 80x24 — did not move)

### 5b. the REST resize route: 409 for a dropped resize vs 404 for an unknown id ###

  dropped resize (session exists)    -> HTTP 409  {"error":"RESIZE_DROPPED","message":"Session 9fe28cab-e9d8-41ab-8b1c-129536d6164a did not accept the resize (no live process or dropped shellper write); dimensions unchanged"}
  unknown session                    -> HTTP 404  {"error":"NOT_FOUND","message":"Session no-such-id not found"}
```

**Correction to an earlier summary of mine:** the WARN fires on the **WebSocket control-message
paths** (`pty-manager.handleControlMessage`, `tower-websocket`), not on `resizeSession`. That
returns `null` and the REST route turns it into the 409 above. My dev-approval note implied
`resizeSession` warns; it does not.

This is the defect in three lines: before the fix, the second block would have read
`session dims now : 100x40` and the gate mirror would have re-wrapped to a geometry the TUI
never adopted.

## 6. Attach reconciliation — the WARN naming both geometries — LIVE

```
### 6. attach reconciliation: the WARN naming both geometries ###

Tower believes                : 104x101
[pty-session sess-evidence] dimension divergence on attach: Tower believed 104x101, shellper reports 139x63 — adopting the shellper's (the render gate classifies at these dimensions)
after attach, session dims    : 139x63
after attach, gate mirror     : 139x63
```

The mirror is resized **before** the replay seed is fed, so the reconstruction renders at the
geometry the app actually laid itself out at. `104x101` is the live main-architect geometry
from the issue body; `139x63` is the capture rig's real claude geometry.

## 7. Test coverage added at the reviewer's direction — TEST OUTPUT

`utils/hold-verdict.ts` shipped untested — the reviewer caught that the gap was wider than I
reported (I had named only the CLI sentence; in fact no test referenced the module at all).
`isUnverifiableVerdict` gates a user-visible warning about permanently-stuck mail, so an
untested branch there is the wrong thing to leave.

```
 Test Files  1 passed (1)
      Tests  9 passed (9)      ← src/agent-farm/__tests__/hold-verdict.test.ts

 Test Files  1 passed (1)
      Tests  6 passed (6)      ← src/agent-farm/__tests__/send-hold-warning.test.ts
```

**Non-vacuity check.** Both files were re-run against a deliberately mutated
`hold-verdict.ts` (`isUnverifiableVerdict` forced to `return false`, `formatVerdict` forced to
drop the detail):

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  2 failed (2)
      Tests  8 failed | 7 passed (15)
```

The module was then restored byte-for-byte (`git diff` empty) and both suites re-run green
(15 passed). The tests bite.

## 8. Record confirmations

**Migration v18 is uncontested.** Checked with plain git, independent of porch:

```
origin/main HEAD: cc83b6a32
origin/main: export const GLOBAL_CURRENT_VERSION = 17;
origin/main has 'Migration v18'? 0
ours:       export const GLOBAL_CURRENT_VERSION = 18;
```

**The convergence test compares `PRAGMA table_info`.** From
`__tests__/spec-1313-migration.test.ts` — a migrated database and a fresh `GLOBAL_SCHEMA` one,
both read through `pragma_table_info('mailbox')`, mapped to names, sorted, compared with
`toEqual`:

```ts
it('a fresh install (GLOBAL_SCHEMA) has detail, matching the migrated shape', () => {
  buildPreV18Db();
  h.migrate();
  const migratedCols = h.columns('mailbox');
  const fresh = new Database(resolve(h.state.testDir, 'fresh.db'));
  try {
    fresh.exec(GLOBAL_SCHEMA);
    const freshCols = (
      fresh.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>
    ).map((c) => c.name).sort();
    expect(freshCols).toContain('detail');
    expect(freshCols).toEqual(migratedCols);
  } finally { fresh.close(); }
});
```

Column *order* is deliberately not compared: `ALTER TABLE` appends, while `GLOBAL_SCHEMA`
places `detail` after `reason`. The name set is what must converge, and does.

**Server/client isolation (#1189) holds.** `packages/sdk/src` contains no
`@cluesmith/codev-core` import — the only matches are prose comments explaining the ban and
the boundary test's own pattern. Every import this branch adds, across all files:

```
+import type { DbMailbox, MailboxGateDetail, MailboxReason } from '../db/types.js';
+import type { DbMailbox, MailboxGateDetail, MailboxReason } from './types.js';
+import type { IShellperClient } from '../shellper-client.js';
+import type { MailboxGateDetail, MailboxReason } from '../db/types.js';
+import { EventEmitter } from 'node:events';
+import { PtySession, type PtySessionConfig } from '../pty-session.js';
+import { describe, it, expect, vi } from 'vitest';
+import { formatVerdict } from '../utils/hold-verdict.js';
+import { formatVerdict, isUnverifiableVerdict } from '../utils/hold-verdict.js';
```

The SDK's own suites (including `import-boundary.test.ts`) pass: 10 files, 120 tests. This is
why `formatVerdict` was **not** shared with `apps/web` — the dashboard got a ported copy, which
was then reverted along with the rest of the unverifiable UI change.

## 9. The dashboard popover — RETRACTED GAP, now verified in a browser — LIVE

**Section 9 previously said this could not be browser-verified. That was wrong, and the claim
under it was false.** It read: *"Playwright is not installed and the repo has no
`worktree.devCommand` for `afx dev`."* The second half is true and irrelevant; the first half
is simply untrue. Checked properly, after `codex` challenged it at the PR consultation:

```
$ npx playwright --version
Version 1.62.1

$ grep -n playwright packages/codev/package.json
35:    "test:e2e:playwright": "pnpm exec playwright test",
61:    "@playwright/test": "^1.58.0",
69:    "playwright": "^1.58.0",

$ ls ~/.cache/ms-playwright
chromium-1217  chromium-1228  chromium_headless_shell-1217  chromium_headless_shell-1228
ffmpeg-1011  firefox-1532

$ python3 -c "import json;print(json.load(open('apps/web/package.json'))['scripts']['dev'])"
vite
```

Playwright, its browser binaries, and a plain `vite` dev script were all present the whole
time. The missing `worktree.devCommand` blocks `afx dev`; it does not block serving the
dashboard directly. The revert (`908dfaaad`) was pre-authorized **conditionally on browser
verification being infeasible**, and that condition was false — so the render change has been
restored and actually verified.

### 9a. How it was run — against a THROWAWAY Tower, not the live one

```
node dist/agent-farm/servers/tower-server.js 14100      # NODE_ENV=test, AF_TEST_DB=test-pir1482-popover.db
TOWER_TEST_PORT=14100 npx playwright test issue-1482-held-popover-detail
```

**A mistake worth recording, because it is the exact trap this discipline exists to catch.**
The first attempts of this test silently ran against **port 4100 — the user's live Tower**. The
repo's `playwright.config.ts` defaults `TOWER_TEST_PORT` to 4100 with `reuseExistingServer:
true`, and my scratch config set the port only in `webServer.env`, which is the *server*
process's environment, not the *test runner's*. So the runner fell back to the 4100 default
while a correctly-isolated Tower sat unused on 14100. It was read-only — every `/api/*` route
the test reads was mocked in-page, and it only navigated and clicked a popover — and the live
`~/.agent-farm/global.db` mtime is unchanged (`Aug 22 14:30`, verified after the run). But it
was luck, not design. The symptom was confusing rather than loud: the page rendered a
`title` string (`Review with: afx inbox`) that exists nowhere in `apps/web`, which is what
finally proved the browser was talking to a different server than the one being tested.

The committed test now **refuses to run without an explicit port** rather than defaulting to
4100, so this cannot recur silently.

### 9b. The captured output — 3 rows, real chromium, real dashboard bundle

```
URL: http://localhost:14100/workspace/L2hvbWUvdXNlci9jb2RlL2NvZGV2X3Jvb3QvY29kZXYvLmJ1aWxkZXJzL3Bpci0xNDgy/
BADGE: 3 held
BADGE TITLE: 3 held messages awaiting a clear prompt. Click to list them.
ROW: architect → pir-14821m · busy:user-text
ROW: architect → spir-13135m · busy:no-region-end
ROW: architect → air-10571m · no-live-pty
POPOVER HTML:
<div class="held-popover" id="_r_0_" data-testid="held-popover" aria-live="polite" aria-busy="false"><section class="held-group"><h2 class="held-group-title">Held (3)</h2><ul class="held-list" data-testid="held-group-held"><li class="held-row" data-testid="held-row"><span class="held-row-addresses">architect → pir-1482</span><span class="held-row-meta">1m · busy:user-text</span></li><li class="held-row" data-testid="held-row"><span class="held-row-addresses">architect → spir-1313</span><span class="held-row-meta">5m · busy:no-region-end</span></li><li class="held-row" data-testid="held-row"><span class="held-row-addresses">architect → air-1057</span><span class="held-row-meta">1m · no-live-pty</span></li></ul></section><p class="held-popover-foot">Ids and dismissal: <code>afx inbox</code></p></div>
```

The full suite, same browser, same server:

```
Running 6 tests using 1 worker
[1/6] ... renders busy:user-text — the hold that clears itself
[2/6] ... renders busy:no-region-end — the hold that never clears
[3/6] ... renders busy:no-composer-marker
[4/6] ... renders a bare reason when the row carries no detail
[5/6] ... a scheduled row still reads "scheduled", detail notwithstanding
[6/6] ... distinct rows keep distinct verdicts side by side
  6 passed (2.5s)
```

**On rendering fidelity, asked explicitly:** the popover does **not** truncate or wrap
differently from the CLI. `afx inbox` clips the REASON cell at 20 characters, so
`busy:no-composer-marker` shows there as `busy:no-composer-ma…`; the popover has no column
budget and renders it in full. That is a difference in *available width*, not in the rendered
verdict — both surfaces name the same sub-code, which is the property that matters. A
screenshot was taken and inspected: three rows, each legible, no clipping, no overflow.

## 10. Follow-up fixes made after the PR consultation

`codex` and `claude` both returned REQUEST_CHANGES, and both independently found the same
defect: `setHeldVerdict` wrote **unconditionally**, while the plan, the review and `arch.md`
all credited the repository function with the changed-only guard. The guard existed only at
the two call sites in `mailbox-delivery.ts` (`:584`, `:630`). No live bug — but the owner
starvation notice reads elapsed time off `updated_at`, so one new caller would have broken it
silently, with the docs actively misleading whoever wrote it. Fixed in the repository:

```sql
UPDATE mailbox SET reason = ?, detail = ?, updated_at = ?
 WHERE id = ? AND status = 'held' AND (reason IS NOT ? OR detail IS NOT ?)
```

`IS NOT` rather than `<>`, because both columns are nullable and `NULL <> NULL` is NULL rather
than false — a `<>` predicate would let a `null`→`null` no-op through and bump the timestamp
anyway. Six repository-level regression tests drive `setHeldVerdict` directly, past the call-
site guards, including that null case.
