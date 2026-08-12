# Builder task-NHnJ thread

## PLAN phase — BLOCKED (2026-08-12)

Spawned in PIR strict mode for an "ad-hoc task", but no task description exists anywhere:

- `.builder-prompt.txt` says only "You are implementing an ad-hoc task."
- porch `## Goal` for the plan task is literally `task-NHnJ` (my builder id).
- No GitHub issue is linked; `status.yaml` has no issue number.
- `afx inbox` is empty (no held messages).

Cannot draft a plan without knowing what to build. Notified the architect via
`afx send architect` (routed to the `security` architect) requesting the task
description or an issue number. Holding at the plan phase — porch not advanced.

## PLAN phase — task received, plan DRAFTED, holding before commit (2026-08-12)

Architect supplied the task: harden the Tower local HTTP+WebSocket API to require
request authentication (private security lane, advisory referenced by id only).
Read the advisory in full for context; all committed artifacts stay strictly
mechanics-free (hardening framing, never exploit mechanics/scenario).

Plan written to `codev/plans/builder-task-nhnj-task-NHnJ.md`. Scope narrowed per
architect to **five core layers** (HTTP key enforcement, WebSocket key enforcement,
CORS allowlist, cross-client rollout, BRIDGE_MODE). Key rotation is a **deferred
follow-up (out of scope)** — noted, not implemented.

Grounded the plan with codebase investigation + a client-transport map. Key facts:
- Single HTTP choke point `isRequestAllowed` (server-utils.ts:80, returns true)
  called in `handleRequest` (tower-routes.ts:233); shared key at
  `~/.agent-farm/local-key` via `@cluesmith/codev-core/auth` (ensure/readLocalKey).
- WS auth surface is only two clients: web dashboard (`apps/web`, sends nothing on
  WS) and VS Code (`apps/vscode`, sends key in-band post-open) → move both to
  `Sec-WebSocket-Protocol`. sdk/tower.html/streamdeck open no terminal WS.
- Header inconsistency: sdk/vscode/streamdeck send `codev-web-key`; browser pages
  (`apps/web`, tower.html) send `Authorization: Bearer` → standardize on `codev-web-key`.

**HOLD:** architect asked me to draft only and NOT commit/push yet (a disclosure-
tolerance question re: the branch being on public origin is with the human).
Awaiting explicit "go" before committing the plan and signalling `porch done`.

## PLAN phase — hold lifted, plan committed+pushed, then BLOCKED on porch check (2026-08-12)

Hold lifted (human accepted public-branch tolerance). Locked the three named design
calls in the plan (WS transport = Sec-WebSocket-Protocol; CORS = fixed origin
allowlist; constant-time compare = crypto.timingSafeEqual length-guarded), committed
+ pushed the plan (commit aabb5bc25, builder/task-NHnJ).

**BLOCKED:** `porch done` fails the `plan_exists` check ("Plan not found") even though
`codev/plans/builder-task-nhnj-task-NHnJ.md` exists and is committed. Root cause is a
porch defect, NOT the plan: `matchesProjectId` (packages/codev/src/commands/porch/
artifacts.ts:63) only recognizes project ids that are numeric ("42") or prefix-N
ending in digits ("bugfix-237"). This project's id `builder-task-nhnj` ends in letters,
matching neither shape, so the artifact resolver returns false for the plan file AND
the project dir. `plan_exists` (and all downstream artifact checks) can never pass for
this id, and no plan filename/location can satisfy it. Verified empirically with a
node repro of matchesProjectId. Did NOT hand-edit status.yaml or bypass the check.
Escalated to architect with options (re-init under a porch-compatible numeric/prefix-N
id, vs. a separate area/porch fix to the id matcher). Likely affects ALL ad-hoc
`builder-*` PIR spawns. Awaiting decision.

## PLAN phase — re-init under porch-native id `secfix-1`, unblocked (2026-08-12)

Architect confirmed root cause = the `--task` spawn minted a porch-incompatible id
(not a matcher bug to patch). Main verified re-init is session-safe (Tower keys on
builder id + workspace path; no project_id column). Executed the architect's steps in
this worktree:
- `porch init pir secfix-1 tower-auth-hardening` → new project `secfix-1-tower-auth-hardening`
  (prefix-N id, matcher-compatible). porch committed its scaffolding (e1a6c9ba4).
- `git mv codev/plans/builder-task-nhnj-task-NHnJ.md codev/plans/secfix-1-tower-auth-hardening.md`
  — 100% rename, plan CONTENT unchanged (mechanics-free as-is; it had zero self-references
  to the old id, so nothing else to touch).
- Re-driving porch from `secfix-1` to raise the plan-approval gate.

Builder id stays `task-NHnJ` (worktree basename), so this thread file keeps its name.
The stale `codev/projects/builder-task-nhnj-task-NHnJ/` dir is harmless scaffolding
(left as-is; not hand-editing any status.yaml).

## IMPLEMENT phase — plan approved by human (Amr), building 5 layers (2026-08-12)

plan-approval gate approved by Amr (explicit); recorded via `porch approve`. porch
advanced to implement. Architect directive: implement all 5 core layers, stop at
dev-approval for a live cross-client review, run cmap after impl code and after tests,
keep artifacts mechanics-free.

Implementation design notes (grounded in code read):
- Expected key: cache `ensureLocalKey()` (@cluesmith/codev-core/auth) lazily server-side;
  fail closed if it throws. Tower owns generation, so the file always exists post-boot.
- HTTP enforcement stays inside `isRequestAllowed(req)` (preserves the test-mock seam) —
  it parses method+pathname, allows a narrow public-route list, else constant-time
  compares the `codev-web-key` header to the expected key. handleRequest reorders so the
  CORS/OPTIONS preflight is answered BEFORE the key check (preflight carries no creds),
  and rejects with 401 (was 403).
- Public routes (keyless): GET /health, GET /api/version, GET / and /index.html, and the
  React SPA static assets under /workspace/<enc>/ EXCLUDING api/, ws/, and the privileged
  `file` reader. Everything else needs the key.
- WS (Layer 2): key via Sec-WebSocket-Protocol; client offers a non-secret marker protocol
  + a `codev-key.<KEY>` token; server validates the token at handleUpgrade and echoes only
  the marker (via ws `handleProtocols`). Fail closed regardless of Origin.
- CORS (Layer 3): fixed origin allowlist (loopback any port + configured tunnel origin);
  add codev-web-key to allowed headers; drop Authorization.
- Clients (Layer 4): vscode terminal-adapter → subprotocol (drop in-band auth frame);
  apps/web api.ts → codev-web-key header, Terminal.tsx → subprotocol; tower.html →
  codev-web-key header + consume same-origin-injected key (server injects in handleDashboard).
- BRIDGE (Layer 5): mandatory enforcement + fail-closed-if-no-key at boot; TLS note.

## IMPLEMENT phase — code + tests done, all green (2026-08-12)

Implemented all five layers across four commits (types wire contracts → server
enforcement → client transport → tests). Results:
- `pnpm --filter @cluesmith/codev build`: exit 0 (types/core/sdk/codev compile).
- apps/web `tsc -b`: exit 0. apps/vscode main tsconfig: exit 0.
- Full codev vitest suite: 4874 passed, 48 skipped, 0 failed.

Design decisions worth flagging for dev-approval review:
- Public-route allowlist (isPublicRoute): GET-only; /health, /api/version, /,
  /index.html, and React SPA static assets under /workspace/<enc>/ EXCLUDING
  api/, ws/, and the privileged `file` reader. Everything else needs the key.
- CORS origin allowlist: loopback (any port) + operator env
  CODEV_TOWER_ALLOWED_ORIGINS (comma-separated) for tunnel/proxy. The tunnel
  subsystem exposes no clean synchronous origin, so I used a static, auditable
  env rather than deep-coupling into it; CORS is defense-in-depth (key is the
  control). Flag for review.
- tower.html key delivery: same-origin serve-time injection into the page
  (window.__CODEV_WEB_KEY__); safe because CORS blocks a cross-origin page from
  reading GET /'s body.

### Out-of-scope pre-existing failure (NOT my diff)
apps/vscode webview tsconfig (tsconfig.webview.json) reports errors in
src/markdown-preview/webview/main.ts: "Cannot find module
'@cluesmith/codev-artifact-canvas'" (that package isn't built in the worktree;
the root build builds it first) plus two pre-existing implicit-any params. I
did not touch markdown-preview/; my vscode change (terminal-adapter.ts) is in
the MAIN tsconfig, which passes clean. Left as-is per the implement prompt's
out-of-scope guidance.

