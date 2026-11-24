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
