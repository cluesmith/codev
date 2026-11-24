# spir-1963 thread — VS Code alternative layout ("Codev Cockpit")

## 2026-11-23 — Specify

No spec existed; wrote `codev/specs/1963-vscode-alternative-layout-seco.md` from the issue.
The issue has no "Baked Decisions" section, but its "Prescribed design choices" are copied into
Constraints as settled.

Findings that shaped the spec:
- Much Agents-view behaviour is bound to the `codev.agents` TreeView *instance* in `extension.ts`
  (click-expands reveal, accordion, active-file reveal, agent-cycle select, badge, title count), and
  every menu `when` names the source view id. A combined view needs that wiring generalised to "the
  view the row is in" — the main risk on the panel side.
- Work/Decisions components hard-import `apps/web/src/lib/api.ts` (relative URLs, injected key,
  localStorage). Sharing them needs a host-adapter seam; recommended a new shared package on the
  `codev-artifact-canvas` pattern.
- The SDK `TowerClient` has no decisions methods, and its `request()` drops non-2xx bodies — the
  decisions refusal `{ok:false, code, message}` needs preserving.
- `window.open` doesn't work in VS Code webviews (no allow-popups) → Decisions' links/full-size
  images need host equivalents.
- Verification must not replace the owner's live IDE extension — isolated instance + fixture
  workspace.

Open points resolved with recommendations, for confirmation at spec-approval: trigger = first show
per window + command; `terminalPosition: panel` overridden for the arrange action; no split/Work/
Decisions in a builder-worktree window (#1809).

## 2026-11-23 — Spec consultation (iter 1) → spec-approval

Codex COMMENT, Claude REQUEST_CHANGES — all points accepted, none disputed (rebuttal in
`codev/projects/1963-*/1963-specify-iter1-rebuttals.md`). Main changes:
- Menus: existing source-view entries left byte-for-byte; the combined view gets mirrored entries
  guarded by a generated parity test (widening `when`s would have broken `contributes-tower.test.ts`).
- Freshness: the combined view and the Work panel count toward the existing periodic-overview
  visibility gate — otherwise the Cockpit freezes whenever the Codev container is hidden.
- Own provider instances over shared caches (per-view accordion/reveal state).
- Added `codev.cockpit.autoArrange` (default on); defined "window session" (ends at reload);
  connection/failure states; canonical-path + http(s)-only host checks; commands stay in the
  palette in worktree/no-workspace windows and explain themselves.

Stopped at spec-approval.

## 2026-11-24 — Owner revision at the gate: one hierarchy

Owner: combined panel is ONE hierarchy — "towers -> workspaces -> architects / decisions ->
builders" — not three sections. Spec otherwise approved as drafted ("Other than that spec sounds
good"); porch approve is waiting on the architect's go after checking the revision.

What the data check found:
- TowerFleetCache already fetches getOverview(path) for every active workspace and discards it
  after deriving attention — retaining it gives every workspace's architects + builders
  (spawnedByArchitect) with no new requests or routes.
- Overview has nothing about the decisions file → no pending count without an additive Tower field.
- All actions (TerminalManager keys/URLs, #1497 resolution, every builder command, diff cache) are
  scoped to the window's own workspace → spec makes other workspaces' rows navigate (open that
  workspace's window); fully cross-workspace action is offered as a gate question / follow-up.
- Attention rows fold onto the rows they concern; stage/area grouping stays in the Agents view;
  dev URLs move to an "Open Dev URL…" context entry on the workspace row.

Revision committed; re-consult (codex + claude, manual — porch is at the gate) running.

## 2026-11-24 — Hierarchy revision re-consult

Codex REQUEST_CHANGES, Claude COMMENT on 76e1dc498; all accepted (rebuttal:
`1963-specify-revision1-rebuttals.md`). Main changes: remote item images are direct `<img>` loads
(CSP img-src gains `http:`; no connect-src), other workspaces' rows get navigate-only
contextValues, the parity test has a checked-in mapping oracle, an Increments subsection (button +
hierarchy → shared package + panels → arrange), active workspace rows click-expand (Open moves to
the inline action), Tower root shows "Not connected to Tower" + Reconnect after the first failed
attempt (ConnectionManager retries forever, never gives up), Loading… child before an overview.
New owner question offered, not specced: a one-time notice on the first auto-arrange.

## 2026-11-24 — Spec approved → plan

Owner approved the spec ("go with your recommendation" on all four): other workspaces navigate-only
(acting in place → #1969), no Decisions pending count (→ #1970), dev URLs as "Open Dev URL…", and
ADD the one-time first-auto-arrange notice. Rulings recorded in the spec (95029fd66); ran
`porch approve 1963 spec-approval` on the architect's relay.

Plan gate is pre-approved by the owner for a plan that implements the approved spec; I still wait
for the architect's go (after their check) before `porch approve 1963 plan-approval`.

Plan (9475ca950): 8 phases on the spec's 3 increments —
1 fleet-cache overview retention · 2 `ArchitectTreeBuilder` extracted from BuildersProvider
(scoped ids, act/navigate modes; Agents ids byte-identical) · 3 Cockpit container + hierarchy +
generalised tree wiring · 4 placement-table menus + parity mapping oracle + rendered check ·
5 `@cluesmith/codev-workspace-views` (source-exported, host adapter, `--codev-wv-*` tokens),
dashboard on wrappers · 6 SDK decisions methods + Decisions panel + Decisions entry · 7 Work panel ·
8 spike then Arrange Cockpit + triggers + notice.
Verification harness: isolated Tower (non-default port, own CODEV_AGENT_FARM_DIR) + `code serve-web`
with isolated data/extension dirs + fixture repos — never :4100 or the owner's /ide/.
Finding while planning: builder rows show no held/queued today, so those counts are Cockpit-only
(an `attentionCounts` option) to keep Agents byte-for-byte.

## 2026-11-24 — Plan consultation → plan-approval

Iter 1: Codex REQUEST_CHANGES, Claude COMMENT. Iter 2: both COMMENT. All points accepted (rebuttals
`1963-plan-iter{1,2}-rebuttals.md`). Things the reviews caught that the code confirmed:
- `requestPreservingBody` reads text → decision images need a binary request path.
- `/api/overview` lists only builders with a LIVE builder terminal, and `spawnedByArchitect` comes
  only from global.db's `builders` row → the harness spawns fixture builders for real
  (`afx spawn --task`, `CODEV_ARCHITECT_NAME`, plain-shell `shell.builder`) against an isolated
  Tower; gate asserts attribution before screenshots.
- `removeArchitect` falls back to the display label (`WEB (0)`); Cockpit architect rows need
  main/sibling context values.
- Hidden retained webviews still report `visibilityState === 'visible'` → host relays panel
  visibility into `useDecisions`' `isActive`.
- Existing webviews use `style-src 'unsafe-inline'`; BuilderCard needs it.
- Windows path cases + windows.yml dispatch for the containment code.

At plan-approval. Owner pre-approved the plan; waiting on the architect's check and go.

## 2026-11-24 — Harness revision (architect: "no go yet")

The architect caught that the plan's `afx spawn --task` "against the isolated Tower" could not have
worked, and the code confirms it:
- `spawn.ts:110` and `spawn-worktree.ts:738` use `getTowerClient()` with no port, so they go to the
  literal 4100;
- there is no env override and no `--port`.

Seeding a ported client in-process doesn't save it either:
- spawn shells out to `porch init` (`spawn-worktree.ts:490`);
- porch's dispatcher then posts `refreshOverview` via `new TowerClient()` to :4100 (`porch/index.ts:1505`).

Other default-port paths:
- `afx tower start`, `workspace add-architect` and notifications;
- the extension, which shells out to `afx` and `porch` (spawn, approve, cleanup, auto-start);
- the extension reads `~/.agent-farm/local-key` unless `CODEV_TOWER_KEY` is set.

**Chosen mechanism: harness-only, no product change.** The harness runs no Tower-contacting CLI
command:
- **Tower:** `tower-server.js -p $PORT` directly, with `CODEV_AGENT_FARM_DIR` and
  `SHELLPER_SOCKET_DIR` (the default socket dir is the owner's `~/.codev/run`).
- **Fixtures:**
  - activation and add-architect over HTTP to the explicit port;
  - porch state and `upsertBuilder` in-process, with the db path pinned and checked;
  - builder terminals via `POST :$PORT/api/terminals`;
  - `afx decisions init`, which is file-only.
- **VS Code:**
  - `CODEV_TOWER_KEY`, `codev.towerPort` and `autoStartTower=false`;
  - recording PATH stubs for `afx`, `porch` and `codev`, so CLI-shelling actions are verified by
    their recorded argv.
- **Safety checks:** a pre-flight that refuses 4100 and checks the listener PID, plus a :4100
  connection tripwire.

**Re-review:** Codex REQUEST_CHANGES, Claude COMMENT. Changes taken:
- the harness became **Phase 1**, with self-tests proving every refusal and the tripwire;
- the layout spike moved into Phase 1 (Codex wanted it before plan approval; offered to the
  architect). b/c/d failures go to the owner, and Phase 9 waits;
- the Cockpit holds the worktree config off `codev-config-updated`, so the request count matches;
- WorkView's `DashboardState` prop leaves the shared surface, and the file-panel slot is the whole
  wrapper;
- the package declares its own test devDependencies and the lockfile changes with them;
- the smoke test builds its own bundle, since CI never builds `dist`.

Phases are now 1–9. Rebuttals are in `1963-plan-harness-rebuttals.md`.

## 2026-11-24 — Layout spike, run before plan approval (architect: strict reading)

Setup: an isolated `code serve-web` on :18763, VS Code 1.147.0. The CLI, server, user and
extensions dirs were all in the scratchpad. A throwaway extension was driven by headless Chromium
from the existing Playwright cache, with no install. There was no Tower, and the serve-web tree had
no :4100 connection. All processes were stopped by PID.

**All four cases held:**
- **(a)** `setEditorLayout` over 5 groups gave 3 (left | top/bottom). Nothing closed, all text was
  intact and dirty stayed dirty. It is idempotent.
- **(b)** An editor terminal moved from group 3 to group 1 with the same PID and shell.
- **(c)** A panel terminal went to the editor area (`moveToEditor`) and then to group 1, intact.
- **(d)** A retained webview moved while visible and while hidden, with no reload (same load id).

**Design fact:** removed groups merge into the LAST group (bottom-right = Decisions). So arrange
reveals Decisions after the layout call.

**Harness lessons from the first run:**
- web defaults `files.autoSave` to afterDelay, which silently saved the "modified" fixtures;
- Restricted Mode raises a trust modal on terminal creation, which hung case b.

Both are now in the harness section. A side gotcha: zsh doesn't word-split `$PIDS`, so a
`kill $PIDS` silently did nothing. I killed per PID instead.

The evidence is in `codev/projects/1963-…/layout-spike/`.

## 2026-11-24 — Phase 1 (verification_harness): harness built, self-test green

I told the architect before the first isolated Tower start. Their OK came at 07:02Z, and they
accepted two deviations:
- **Scratch HOME** for every harness child (Tower, driver, serve-web, browser). This is an extra
  layer beyond the plan.
- **The socket dir is a short `/tmp/cckp-<random>` symlink** to `<scratch>/cockpit-harness/run`.
  macOS caps a Unix-socket path at 104 bytes, and the scratchpad path alone is 135, so a socket dir
  literally under the scratchpad cannot work.
  - Gate 2 checks the realpath, and also checks the socket-path length.
  - Teardown removes the link even after a failed start (the architect's condition).
  - Standing order: if pre-flight or the tripwire fires in a real run, stop and tell the
    architect before retrying.

Findings that shaped the code:
- **Plain-shell fixtures.** A `bash` architect auto-detects the **claude** harness and would be
  handed claude's session and role args. So each fixture's `.codev/config.json` names a no-op custom
  harness (`roleArgs: []`, `roleScriptFragment: ""`).
- **No adopt.** `launchInstance` runs `npx codev adopt` when `codev/` is missing, so fixtures always
  carry `codev/`. The driver fails if activation reports `adopted`.
- **Builder terminals.** `POST /api/terminals` only registers a builder (shellper-backed) with
  `persistent: true`, which the plan table omitted. The driver requires `persistent === true` in
  the response.
- **Machine settings.** User settings in serve-web live in the browser, so the harness writes
  `<user-data-dir>/Machine/settings.json`. Restricted Mode ignores the `codev.tower*` settings only
  from *workspace* settings, so Machine settings still apply.
- **Allowlisted environments.** Child environments are built from an allowlist, so no `CLAUDE_CODE_*`,
  `VSCODE_*`, `CODEV_*`, `NODE_ENV` or token variables leak in.

`harness.mjs selftest` passes all 14 cases:
- gate 1: port 4100, a non-numeric port, and a port that already has a listener;
- gate 2: `~/.agent-farm`, an agent-farm dir outside the scratchpad, `~/.codev/run`, a socket dir
  outside the scratchpad, and an over-long socket dir. Each refuses with nothing created;
- gate 3: a `NODE_ENV=test` driver against a real production-mode isolated Tower refuses, and no
  `test.db` or fixture is created;
- gate 4: a foreign listener refuses;
- teardown by PID, with the link removed;
- the tripwire ignores a connection from outside the tree, and fires (exit 3) on one from a harness
  child.

**Acceptance run from the committed tree (541d60aa0).** I rebuilt the vsix, then ran selftest
(14/14), start, check (10/10), `seed one-builder` (gate 6 shows `builder-spir-101` spawned by
`main`), check again (10/10), and stop (15 PIDs killed, none left, link removed, no listeners). The
workbench renders Agents (1) → SPECIFY → #101 fixture-one from the isolated Tower.

Two things the first live checks caught:
- The trust banner and status item render after the Codev activity-bar item, so trust is now
  detected by `#status.workspaceTrust` once the Codev status item has appeared.
- In 1.147 the Workspace Trust editor is a *modal* editor that blocks clicks, so it is closed with
  Escape.

Separately, the extension activates `alpha` on the isolated Tower by itself when it loads, so
`main` exists before any seed. That is expected and harmless.

### Phase 1 review, iteration 1 (2026-11-24)

- Checks: `porch done` ran the full suite once (build 17.1s, tests 54.0s), and it passed.
- Codex asked for changes. The plan's IDE-server alternative to serve-web was missing. I added
  `COCKPIT_VSCODE=ide-server` with `COCKPIT_IDE_SERVER_BIN`. It launches the VS Code Server
  binary directly with `ide-server.ts`'s flags, all under the scratchpad. The mode is explicit,
  never an automatic fallback, per the fail-fast rule. Verified `start`, `check` 10/10 and
  `stop` (10 PIDs, none left) in that mode.
- Claude approved, with non-blocking notes, and I took them all:
  - the tripwire now starts before the Tower launch;
  - the README now says the tripwire is a detector, not the enforcement;
  - the README now says seeding is once per `start`;
  - removed an unused import;
  - honour `PLAYWRIGHT_BROWSERS_PATH`;
  - two new gate-1 self-test cases.
- Re-verified in serve-web mode. Self-test 17/17, `start`, `check` 10/10, `seed one-builder`
  (gate 6: `builder-spir-101` spawned by `main`), `check` 10/10, `stop` (15 PIDs, none left).
