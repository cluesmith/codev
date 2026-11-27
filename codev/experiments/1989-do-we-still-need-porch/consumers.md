# Experiment 1989 — Consumers: who reads porch's state or runs its commands

Part of experiment #1989; method and scope are in `notes.md`. This file lists everything outside
`packages/codev/src/commands/porch/` that reads porch's state (`codev/projects/<id>-<name>/status.yaml`)
or calls a porch command, with the file and line, and says for each what it would need in two
cases:

- **Absent**: no `status.yaml` and no porch commands.
- **Smaller**: porch keeps the state file, the gates and the records (`init`, a gate request,
  `approve`, `done --pr/--merged`, `status`, `pending`) and drops the orchestration: `next`,
  `done` as phase advance, phase checks, consultation, `rollback`, `skip-phase` and context
  refresh. Under this model `phase` is still current only if some kept command writes it, and
  `plan_phases`, `current_plan_phase`, `iteration`, `history` and `context_refreshes` stop being
  kept.

This file describes code; it reaches no conclusion about keeping or retiring porch.

**How it was found.** Greps over the whole worktree at base `ab0fa50a9` for `status.yaml`,
`commands/porch`, imports from porch modules, `porch <subcommand>`, and each `status.yaml` field
name (`gates`, `plan_phases`, `current_plan_phase`, `pr_history`, `pr_ready_for_human`,
`force_advanced`, `context_refreshes`), then reading each hit. The sweep was done by a reader agent.
Every file:line below was then printed and checked against its claim by this builder. Where the
reader's line was off by one or pointed at a brace, the line given here is the corrected one.
Tests are not listed one by one.

The porch command surface, for reference: `packages/codev/src/commands/porch/index.ts:1396-1508`
(`pending`, `next`, `status`, `check`, `done`, `gate`, `approve`, `rollback`, `skip-phase`,
`verify --skip`, `init`). The state type is `packages/codev/src/commands/porch/types.ts:199-267`.

---

## 1. The shape of it

**One choke point.** Every UI gets porch state through one parser:
`parseStatusYaml` at `packages/codev/src/agent-farm/servers/overview.ts:83`, which `discoverBuilders`
reads per worktree (`overview.ts:817-844`). It becomes the `OverviewBuilder` records on
`GET /api/overview` (wire type `packages/types/src/api.ts:160-256`). `afx status`, the dashboard,
VS Code, the SDK, core agent-state and the Stream Deck plugin all read that, never `status.yaml`
directly. Outside that path the direct readers are few: `consult`, `afx reset` / `afx self-refresh`,
`afx workspace recover`, the Spec 1252 metrics script, and the dead `team update` check
(section 7).

**Porch absent already has a shape.** A worktree with no `status.yaml` becomes a "soft" row:
id from the directory name, no phase, no gates, progress 0 (`overview.ts:765-789`, `:862-884`).
Nothing crashes. Every gate and phase signal disappears.

**Soft mode today is not porch-absent.** `afx spawn` runs `porch init` whatever the mode
(`packages/codev/src/agent-farm/commands/spawn.ts:466-469`, `:866`, `:870`, through
`spawn-worktree.ts:490`). The overview then marks every builder that has a `status.yaml` as
`mode: 'strict'` (`overview.ts:834`). So a soft builder appears in every UI as a strict builder
whose phase never moves past the one `porch init` wrote. Unless it runs porch's gate commands
itself, it never shows as blocked at a gate. This builder (`experiment-1989`, spawned `--soft`)
has such a file: `codev/projects/1989-experiment-do-we-still-need-po/status.yaml`, `phase: hypothesis`,
committed by `chore(porch): 1989 init experiment` (`01949988a`). This matters for reading the
controlled run's dashboards; it is stated here as a fact about the code, not scored.

**Reverse edges.** Porch also calls out: after a mutating command it asks Tower to refresh the
overview (`commands/porch/index.ts:1519-1520`). After an `approve` run from outside the
worktree, it sends the builder `Gate X approved — run porch next` through `afx send --raw`
(`index.ts:857` into `commands/porch/notify.ts:46`). Porch does not notify the architect when a
gate is requested. The task text tells the builder to send that message itself
(`commands/porch/next.ts:355`).

---

## 2. Tower and `afx`

| Consumer | file:line | Reads / calls | Used for | If absent | If smaller |
|---|---|---|---|---|---|
| Overview parser | `servers/overview.ts:83`; fields `:106` id, `:109` title, `:112` protocol, `:115` phase, `:118` current_plan_phase, `:121` started_at, `:124` pr_ready_for_human, `:163` gate status, `:186` plan_phases, `:213` pr_history | Line scan of the worktree's `status.yaml` | Every `OverviewBuilder` | Another record of "gate requested / approved" and of phase. Otherwise every builder is a soft row | Gates, pr_history and started_at still parse. Phase only if still written. plan_phases is empty |
| Builder construction | `overview.ts:825` id, `:827` title, `:828-830` phase = current_plan_phase else phase, `:833` protocolPhase, `:834` mode, `:838` protocol, `:844` startedAt | As above | Identity, phase label, strict/soft badge | id from directory or global.db (the soft row already does this) | Works, except the phase label |
| Progress bar | `overview.ts:258` `calculateProgress`; SPIR `:274-298`; even split `:308` through `loadProtocol` imported from porch at `:22`, called `:327` | phase, gates, plan_phases, `protocol.json` phases | Progress on dashboard, VS Code, Stream Deck | 0, or derived from PR state. `loadProtocol` must move out of porch | Degraded: needs phase. Without plan_phases, SPIR implement stays at one value |
| Gate detection | `overview.ts:377` `findBlockedGate`, `:388`, `:399`, `:411` | gate `status: pending` with `requested_at` | `blocked`, `blockedGate`, `blockedSince`, which feed every attention view | A gate-requested record | **Works.** This is what the smaller model keeps. A gate-request command must still write `requested_at` |
| PR ready | `overview.ts:447` `derivePrReady` | pr gate + last `pr_history.merged` | "PR waiting on human" | Forge PR state. The dashboard already does this for PRs with no builder (`packages/workspace-views/src/components/NeedsAttentionList.tsx:97`) | Works |
| Idle time | `overview.ts:456` `computeIdleMs` | gate `requested_at` / `approved_at` (the only reader of `approved_at`) | Takes gate waits out of the card's elapsed time | Wall-clock time | Works |
| Agent attention state | `servers/tower-routes.ts:1645-1649` into `servers/agent-state/serve.ts:67`, into `packages/core/src/agent-state.ts:79` (blocked wins) and `:83` (finished phase suppresses "dead") | blocked, blockedSince, phase | Spec 1595 attention states | blocked is always false; "finished" needs another signal (PR merged, cleanup) | blocked works; "finished" needs phase |
| `afx status` | `commands/status.ts:121` (through `discoverBuilders`), table `:242`, `--json` `:348` | Same as the overview | Phase and Gate columns | Columns show `—` | Gate works; Phase only if written |
| `afx spawn` runs `porch init` | `commands/spawn-worktree.ts:490`; callers `commands/spawn.ts:469`, `:585`, `:866`, `:870`; failure only warns (`spawn-worktree.ts:493`) | **command** `porch init` | Creates the worktree's `status.yaml` | Nothing, or spawn writes a minimal record | Works (`init` is kept) |
| Strict-mode selection | `commands/spawn-roles.ts:335` `resolveMode`; `spawn.ts:876` | `protocol.json` `defaults.mode` | Picks the strict text of `builder-prompt.md` | Soft text only | Strict text needs rewriting (it says `porch next`) |
| Resume notice | `commands/spawn-roles.ts:166` `buildResumeNotice`; used `spawn.ts:501`, `commands/reset/reorient.ts:462` | Tells the builder to run `porch next` / `porch init` | Re-entry after `--resume` or reset | Reword to "read thread, plan, git log" | **Breaks**: says `porch next` |
| Crash-resume nudge | `commands/spawn-worktree.ts:915` `CRASH_RESUME_NUDGE` | Tells the builder to run `porch next` in strict mode | Restarted builder re-orients | Reword | **Breaks**: needs rewording |
| Spec lookup | `commands/spawn.ts:52` imports `commands/porch/artifacts.js`; `:359` | Porch's artifact resolver (files, not state) | Find the spec | Move `artifacts.ts` out of porch | Works |
| `afx cleanup` porch tidy | `commands/cleanup.ts:579` calls `cleanupPorchState` (`:40`), which keeps `status.yaml` (`:57`) "for analytics" (`:38`) | Directory prefix `${builder.id}-` | Deletes review artifacts at cleanup | Delete it | Harmless. See section 7: the prefix almost never matches |
| `afx workspace recover` | `commands/workspace-recover.ts:15` imports `listAllProjects` from porch, `:327`; `:110` terminal phase, `:153` protocol, `:157`, `:166` id, `:269`, `:360` updated_at | id, protocol, phase, updated_at | Which builders to revive after a reboot | global.db builder rows + existing worktrees; "terminal" = PR merged | Works if phase is written |
| `afx reset` / `self-refresh` context | `commands/reset/context.ts:313-325` (`:317` protocol, `:318` phase, `:319` id, `:325` current_plan_phase); fallback `:580`; callers `commands/reset.ts:128`, `commands/self-refresh.ts:290` | protocol, phase, id, current_plan_phase | Re-orientation frame after a clear | The builder-id fallback exists | Works for id/protocol |
| Re-orientation text | `commands/reset/reorient.ts:242` (prints project/phase), `:269` and `:404` ("Run `porch next`") | Prints state; tells the builder to run `porch next` | A cleared builder's re-entry | Drop the porch block | **Breaks**: says `porch next` |
| Self-refresh boundary | `commands/reset/self.ts:101` imports `enterBoundary` from porch; `:315`; `:953`, `:996` ("It will tell you to run `porch next`") | Porch's boundary ids | Automatic refresh at protocol boundaries | Architect-triggered `afx refresh` only | **Breaks**: context refresh is orchestration |
| `team update` gate events | `commands/team-update.ts:55-66` | A top-level `approved: true` line | "Gate approved for #N" in the hourly team post | Nothing lost | Nothing lost. **Already dead** (section 7) |

All paths in this table are under `packages/codev/src/agent-farm/` unless shown in full.

## 3. Dashboard and shared views (`apps/web` hosts `packages/workspace-views`)

| Consumer | file:line | Reads | Used for | If absent | If smaller |
|---|---|---|---|---|---|
| SDK `deriveAttention` (dashboard and VS Code) | `packages/sdk/src/builder-helpers.ts:235` | blocked, prReady | Pending-gate and PR-review rows | Gate rows lost; PR rows from forge | Works |
| SDK finished / idle | `builder-helpers.ts:61` (phase complete/verified), `:88` (blocked is not "waiting") | phase, blocked | Hide waiting/dead for finished lanes | A "lane finished" signal | Needs phase |
| SDK stage grouping | `packages/sdk/src/phase-grouping.ts:68` `PHASE_TO_STAGE`, `:100` | protocolPhase | Stage buckets | Everything is `unknown` | Needs phase |
| BuilderCard | `packages/workspace-views/src/components/BuilderCard.tsx:25` blocked, `:45` mode, `:49` plan phases "(n/m)", `:89` and `:140` elapsed, `:103` progress | blocked, mode, phase, planPhases, startedAt, idleMs, progress | Card state, phase, progress, elapsed time | "running" + wall time | blocked and elapsed work; phase/progress need phase; "(n/m)" lost |
| Needs Attention | `NeedsAttentionList.tsx:77` (prReady), `:92-97` (PR rows, with the no-builder fallback at `:97`), `:126`, `:161` | prReady, blocked, blockedSince | The dashboard's "Needs attention" | PR rows by the existing fallback; no gate rows | Works |
| Dashboard tips | `apps/web/src/lib/tips.ts:19-25` | Text naming `porch pending/next/done/approve` | Rotating tips | Delete | Edit the `next`/`done` lines (`:21`) |

## 4. VS Code extension and Stream Deck plugin

| Consumer | file:line | Reads / calls | Used for | If absent | If smaller |
|---|---|---|---|---|---|
| Approve Gate command | `apps/vscode/src/commands/approve.ts:191`, `:204`, `:230`; **calls `porch approve … --a-human-explicitly-approved-this` directly** at `:357` (only when no architect is live; otherwise it relays to the architect, #1494); registered `apps/vscode/src/extension.ts:1466`; menus `apps/vscode/package.json:797`, `:807` | blocked, blockedGate; **command** `porch approve` | The human's approve click | A gate record to approve | Works |
| Gate toast | `apps/vscode/src/notifications/gate-toast.ts:59`, `:104` (actions keyed by gate name), `:136` | blocked, blockedGate | Toast when a gate appears | None | Works |
| Command relay (Stream Deck to VS Code) | `apps/vscode/src/command-relay.ts:49`, `:108` | Routes `approve-gate` | Stream Deck Approve key | None | Works |
| Tree rows | `apps/vscode/src/views/builder-row.ts:42` (gate icon), `:101`, `:175`, `:212`, `:229` (tooltip: protocol, mode, progress) | blocked, blockedGate, blockedSince, protocol, mode, progress | Row icon, label, tooltip | Never blocked | Works; progress needs phase |
| Tree order and menus | `apps/vscode/src/views/architect-tree.ts:66`, `:660`, `:689` (`contextValue` = state + protocol), into `package.json:813`, `:818`, `:823` (View Spec / Plan / Review by protocol) | blocked, blockedSince, blockedGate, protocol | Sort, icons, which "View…" menus appear | Protocol from the builder row; soft rows give `unknown`, so the menus vanish | Works |
| Stage grouping | `apps/vscode/src/views/builder-grouping.ts:67`, `:83`, `:134` | protocolPhase | Tree grouping, `[phase]` prefix | All `unknown` | Needs phase |
| Blocked count | `apps/vscode/src/extension.ts:460`; `apps/vscode/src/mailbox-indicators.ts:159` | blocked | "N blocked" status bar and badge | 0 | Works |
| Cross-workspace attention | `apps/vscode/src/views/tower-cache.ts:188`; `apps/vscode/src/contextual-panel/panel-provider.ts:251` (webview "Pending gates", `contextual-panel/webview/main.ts:181`) | Through `deriveAttention` | Attention across workspaces | None | Works |
| View plan/review | `apps/vscode/src/commands/view-artifact.ts:97` (`${builder.id}-` prefix) | `OverviewBuilder.id` (= `status.yaml` id) | Find this builder's plan/review files | With no `status.yaml` the id is the directory name (`spir-42-slug`), so `42-slug.md` is missed; needs an issue-id filter | Works |
| Quick-pick labels | `apps/vscode/src/commands/cleanup.ts:40`; `apps/vscode/src/builder-pick-rows.ts:69` | phase | Description text | Empty | Needs phase |
| Stream Deck key face | `apps/streamdeck/src/face.ts:33`, `:140` (`stateLabel`: gate, then protocolPhase) | blockedGate, protocolPhase | Key colour and label | Always "active" | Gate works; phase label needs phase |
| Stream Deck actions | `apps/streamdeck/src/actions.ts:345-353` (Approve key needs `blockedGate`), `:557` (which artifact the dial opens), `:722`, `:745` (progress) | blockedGate, protocolPhase, progress | Approve key; dial auto-open | Approve inert; diff fallback | Approve works; artifact choice needs phase |
| Cockpit harness (manual; CI only syntax-checks it) | `apps/vscode/scripts/cockpit-harness/fixtures.mjs:328` (imports porch's protocol module), `cockpit-verify.mjs:1086` (regex-edits gates), `:827` (asserts the relay makes no porch call) | porch module, `status.yaml` gates | Rendered check of gate UI | Fixture rewrite | Works |

## 5. `codev check`, audits, metrics, analytics, `consult`

| Consumer | file:line | Reads / calls | Used for | If absent | If smaller |
|---|---|---|---|---|---|
| `codev check pr`: skip porch-only commits | `packages/codev/src/commands/check/porch-only.ts:24` (`codev/projects/`), `:54` `isPorchOnly`, `:71`; called from `commands/check/pr.ts:47`, `:417` | git diff-tree of head commits | Finds CI on the real code below porch's `status.yaml` commits. It exists **because** porch commits state onto the PR branch | Unneeded | **Still needed**: a smaller porch still commits state |
| `codev check deploy` | `commands/check/deploy.ts:22`, `:226` | Shared helper only | — | Move the helper | Works |
| `codev check` settings, keep-list | `commands/check/settings.ts:30`; `packages/codev/src/agent-farm/lib/keep-list.ts:11` | Path `codev/projects/**` | Ignore / keep porch files | Harmless | Works |
| PR-gate audit (`codev doctor`, `codev update`) | `packages/codev/src/lib/pr-gate-audit.ts:84`; callers `commands/doctor.ts:1621`, `commands/update.ts:412` | `protocol.json` gate names (porch's input format) | Warn when a PR protocol no longer raises the `pr` gate the UIs key on | Obsolete | Still meaningful |
| Prompt-behaviour metrics (Spec 1252) | `packages/codev/src/lib/prompt-behavior-metrics.ts:162` (every `status.yaml` at the workspace root), `:181`, `:185` `history`, `:192` verdicts; entry `packages/codev/scripts/measure-prompt-behavior.ts:17` | `history[]` | Review-round and REQUEST_CHANGES rates | Mine review `.txt` files or consult metrics | **Breaks** for new projects (no `history`). Old files stay readable |
| `consult` reads builder state | `packages/codev/src/commands/consult/index.ts:302`; read `:358`; `:362` id, `:363` title (parsed, unused), `:364` current_plan_phase, `:365` phase, `:366` iteration; used `:2633`, `:2672` (`--type phase`), `:3029` (auto-saves `<id>-<phase>-iter<N>-<model>.txt`, the path porch reads verdicts from, `:385`); project detection `:341` | id, phase, current_plan_phase, iteration | Builder-context consults without `--issue`; output where porch looks | Pass `--issue/--project-id/--output` | Partial: iteration and plan phase freeze, so output names collide and `--type phase` needs `--plan-phase` |
| `consult` imports porch | `consult/index.ts:28` (`commands/porch/artifacts.js`); flags "used by porch" `commands/consult/cli-options.ts:40` | Artifact resolver | Spec/plan lookup | Move `artifacts.ts` | Works |
| Analytics: agent time per protocol | `packages/codev/src/agent-farm/servers/analytics.ts:402`; columns `commands/consult/metrics.ts:51`; filled from consult `--protocol`/`--project-id` (`consult/index.ts:2952`), which **porch writes into the commands it emits** (`commands/porch/next.ts:586`, `:620`) | Indirect: porch-emitted consult flags | Dashboard analytics by protocol | Protocol survives where `--protocol` is passed; project id is lost unless the builder passes it | Prompts must carry the consult commands with `--project-id` |
| Analytics otherwise | `analytics.ts:4` (sources: GitHub and metrics.db), `:271` | — | — | — | Does **not** read `status.yaml` (section 7) |

## 6. Cron

| Consumer | file:line | Reads | If absent | If smaller |
|---|---|---|---|---|
| `.af-cron/team-update.yaml` | `.af-cron/team-update.yaml:4` (`team update`), into `packages/codev/src/cli.ts:330`, into `team-update.ts:64` | A top-level `approved:` line that porch never writes | Nothing lost | Nothing lost |
| `.af-cron/ci-health.yaml` | `.af-cron/ci-health.yaml:9` | `gh run list` only | — | — |

No other cron task reads porch state.

## 7. Dead or broken consumers found on the way

- **`team update` gate events never fire.** `team-update.ts:64` tests `/^approved:\s*true/m`. Porch
  writes `gates.<name>.status: approved`, never a top-level `approved:`. `grep -l -E
  '^approved:\s*true' codev/projects/*/status.yaml` matches 0 of 365 files. The hourly cron post
  has never reported a gate.
- **`afx cleanup`'s porch tidy almost never matches.** `cleanup.ts:579` passes `builder.id`, which
  is `builder-<protocol>-<id>` (`packages/codev/src/agent-farm/utils/agent-names.ts:62`), as the
  prefix. Porch directories are `<id>-<slug>` or `bugfix-<id>-<slug>`. The only directory shape it
  can match is a task builder's (`codev/projects/builder-task-nhnj-task-NHnJ/`, created by
  `porch init` for a task builder on 2026-08-12, `0cc35cca2`).
- **Push notifications for porch events are unreachable.** `notifyGateHit` and `notifyBlocked`
  (`packages/codev/src/agent-farm/utils/notifications.ts:97`, `:113`) have no importer anywhere in
  `packages/` or `apps/`.
- **"Preserve status.yaml for analytics" has no analytics reader.** `cleanup.ts:38` and the
  committed status files on `main` exist "for analytics". `analytics.ts` reads GitHub and the
  consult metrics database only. The only reader of the `status.yaml` files on `main` is the
  Spec 1252 metrics script (section 5), plus the root fallback in `afx workspace recover`.
- **`scripts/measure-prompt-surface.sh:215`** counts `codev-skeleton/porch/prompts`, a directory
  that no longer exists.

## 8. Skills

The `.claude/skills/*` files have byte-identical twins in `codev-skeleton/.claude/skills/*`.

| Skill | file:line | What it tells the agent | If absent | If smaller |
|---|---|---|---|---|
| porch | `.claude/skills/porch/SKILL.md:14` onward (the command list; the whole file is porch) | Every porch command | Delete | Shrink to the kept commands |
| afx | `.claude/skills/afx/SKILL.md:28` (`--strict`: porch orchestrates, the default), `:256` (Phase/Gate columns come from the worktree's `status.yaml`) | Spawn mode; what `afx status` shows | Reword | `:28` reword |
| builder-refresh | `.claude/skills/builder-refresh/SKILL.md:21` ("Porch chooses the moment. You do not."), `:31`, `:100`, `:126` (run `porch next`), `:134` | Refresh only when porch says | Architect-triggered only | **Breaks**: nothing triggers it |
| consult | `.claude/skills/consult/SKILL.md:49` (flags for porch), `:98` (in strict mode run the commands porch emits), `:115` (project auto-detected from porch state) | — | The builder writes its own consult commands | `:98` becomes false |
| arch-init, arch-save | `.claude/skills/arch-init/SKILL.md:63`, `:81`, `:176`; `.claude/skills/arch-save/SKILL.md:277` | Gate discipline: the builder runs `porch approve`; never auto-approve | A gate mechanism to name | Works |
| update-arch-docs | `.claude/skills/update-arch-docs/SKILL.md:11` (hot docs "injected into every porch prompt") | — | Hot docs reach builders through CLAUDE.md only | Works if prompts stay |

## 9. Roles, prompts, protocols, templates

`codev/protocols/*` and `codev-skeleton/protocols/*` are identical apart from `release`, which has no
porch references. Skeleton paths are given and apply to both. Roles are twins at the same lines.

| Consumer | file:line | Porch use | If absent | If smaller |
|---|---|---|---|---|
| Builder role | `codev/roles/builder.md:10`, `:13` (strict = the `next`/`done` loop), `:16` (never edit `status.yaml`), `:29` (builder runs `porch approve`), `:65` (verify: `porch done`), `:103` (`done --pr/--merged`), `:148` (porch checks) | The builder's whole loop | A loop driven by the protocol document, as soft mode is now | `:10`, `:13`, `:65`, `:148` reworded; `:29`, `:103` fine |
| Architect role | `codev/roles/architect.md:38` (relay text "Run: porch approve …"), `:41`, `:53` (CI on code, not porch commits), `:148` (`porch status`) | Gate relay, PR review | A gate mechanism | Works |
| SPIR builder prompt | `codev-skeleton/protocols/spir/builder-prompt.md:15`, `:18`, `:68`, `:74`, `:82`, `:85` (`verify --skip`) | next, done, verify | Soft text | Partial |
| SPIR phase prompts | `spir/prompts/specify.md:37`, `:50`; `plan.md:38`, `:51`; `implement.md:20`, `:33`, `:35`, `:38` (never bypass a porch check); `review.md:25`, `:42`, `:75`, `:79` (`porch approve … pr`), `:80` | Each phase ends `porch done`, then `porch next` hands over the consult commands | Prompts say what comes next themselves | **Breaks** |
| SPIR `protocol.md` | `spir/protocol.md:67`, `:79`, `:109` | done/next, approve, status | Reword | Partial |
| SPIR plan template | `spir/templates/plan.md:11` ("porch parses this JSON to track phase progress") | Feeds `plan_phases` | Optional | **Breaks** (no `plan_phases`) |
| ASPIR | `aspir/builder-prompt.md:15`, `:16`, `:69`, `:75`, `:83`, `:86`; `aspir/prompts/*` at the same lines as SPIR; `aspir/protocol.md:29`, `:45` | Same as SPIR | Same | **Breaks** |
| AIR | `air/builder-prompt.md:14`; `air/prompts/implement.md:31`; `air/prompts/pr.md:72` (`porch done` fires the `pr` gate); `air/protocol.md:39` | Loop + pr gate | Same | Partial: the pr gate survives |
| BUGFIX | `bugfix/builder-prompt.md:14`; `bugfix/prompts/investigate.md:22`, `:24`; `fix.md:25`; `pr.md:66`, `:69`, `:72` (`porch approve … pr`), `:75`; `bugfix/protocol.md:44`, `:56` | Loop + pr gate | Same | Partial |
| BUGFIX / MAINTAIN review types | `bugfix/consult-types/impl-review.md:31`, `pr-review.md:26`; `maintain/consult-types/impl-review.md:28`, `pr-review.md:20` | Tell reviewers to ignore porch's `status.yaml` in the diff | Drop the line | Keep |
| PIR | `pir/builder-prompt.md:14`, `:47`, `:59`, `:71`; `pir/prompts/plan.md:18`, `:95`, `:99`, `:111` (`approve … plan-approval`); `implement.md:18`, `:108`, `:134` (`approve … dev-approval`); `review.md:20`, `:130`, `:136` ("status views and audit trails" need `pr_history[].pr_number`), `:141`, `:170`; `pir/protocol.md:36`, `:42` (`porch pending`) | next, done, done --pr, approve, pending | Same | Partial: three gates survive, the loop does not |
| MAINTAIN | `maintain/builder-prompt.md:14`; `maintain/prompts/maintain.md:75`; `review.md:75`, `:78` (`approve … maintain-complete`); `maintain/protocol.md:64` | next, done, approve | Same | Partial |
| EXPERIMENT, RESEARCH, SPIKE | `experiment/builder-prompt.md:14`; `research/builder-prompt.md:14`; `research/protocol.md:6`; `spike/builder-prompt.md:14` (none has a `prompts/` directory) | Strict-mode framing only | Soft text | Partial |
| `protocol.json` (porch's input) | e.g. `spir/protocol.json:12` (`context_refresh`), `:26` (`verify`), `:31` (`checks`), `:46` (`gate: spec-approval`); `aspir/protocol.json:11`, `:30`, `:148`; `air/protocol.json:30`, `:73`; `bugfix/protocol.json:44`, `:79`; `experiment/protocol.json:70`; `maintain/protocol.json:32`, `:65`; `pir/protocol.json:34`, `:37`; `research/protocol.json:26` | Gates, checks, verify lanes, refresh points | The **gate names** are what Tower, VS Code and Stream Deck key on (`overview.ts:350` labels, `builder-row.ts:42` icons, `face.ts`), so they must live somewhere | Gates kept; checks, verify and refresh become documentation |
| Schema | `codev-skeleton/protocols/protocol-schema.json:5`, `:74`, `:78`, `:113`, `:155` | Describes porch's input | — | Edit |
| Templates | `codev-skeleton/templates/cheatsheet.md:137`; `lifecycle.md:134`, `:144`; `CLAUDE.md:113`; `AGENTS.md:115`; `arch-critical.md:3`; `lessons-critical.md:4` ("into every porch phase prompt") | Adopter-facing text | Edit | Edit the `next`/`done` lines |
| `CLAUDE.md` / `AGENTS.md` (twins) | `CLAUDE.md:68` (gate rule), `:81` (builder runs approve), `:112` (`porch status <id>`); `codev/resources/arch-critical.md:13`, `:18` | Always-on rules | Edit | Works |
| Reference docs | `codev-skeleton/resources/commands/overview.md:78`; `workflow-reference.md:130`; `commands/consult.md:231`; `commands/agent-farm.md:277`, `:763` | Text | Edit | Edit |

## 10. CI and scripts

| Consumer | file:line | Porch use | If absent | If smaller |
|---|---|---|---|---|
| Install check | `packages/codev/scripts/verify-install.mjs:81` (the `porch` binary must answer `--help`); run from `.github/workflows/test.yml`, `post-release-e2e.yml`, `windows.yml` | `porch --help` | Drop `porch` from the list | Works |
| Porch's own e2e suite | `.github/workflows/test.yml:269` (`--exclude 'src/commands/porch/__tests__/e2e/**'`) | Excluded from CI; no workflow runs it | — | — |
| Cockpit stub syntax check | `.github/workflows/test.yml:121` | `sh -n stubs/porch` | Drop | Works |
| Leftover allow-list | `scripts/tmp-residue-allowlist.json:248`, `:252` | Two porch test files | Drop | — |

No workflow reads `status.yaml` or runs a porch subcommand. The git hooks, the worktree write
guard and `.claude/settings.json` reference no porch file or command.

---

## 11. `status.yaml` fields and who reads them outside porch

| Field | Readers outside porch |
|---|---|
| `id` | overview `:106` (builder id `:825`); consult `:362`; reset context `:319`; workspace recover `:157`, `:166`, `:266`; VS Code view-artifact `:97` (through the overview id) |
| `title` | overview `:109` (fallback, replaced by the forge title at `overview.ts:1220`); consult `:363` (parsed, unused) |
| `protocol` | overview `:112` (progress, tooltip, VS Code menus); reset context `:317`; workspace recover `:153` |
| `phase` | overview `:115` (afx status, SDK finished/grouping, BuilderCard, Stream Deck, core agent-state `:83`); consult `:365` (output file name); reset context `:318`; workspace recover `:110` |
| `plan_phases` (`id`, `title`, `status`) | overview `:186`, into progress and BuilderCard "(n/m)" (`BuilderCard.tsx:49`). `skip_reason` / `skipped_at`: nobody |
| `current_plan_phase` | overview `:118` (display phase); consult `:364`; reset context `:325` |
| `gates.<g>.status` | overview `:163` (blocked, prReady, progress); cockpit harness `cockpit-verify.mjs:1086` |
| `gates.<g>.requested_at` | overview (blocked, blockedSince, prReady, idle time) |
| `gates.<g>.approved_at` | overview `computeIdleMs` (`:456`) only |
| `iteration` | consult `:366` (output file name) only |
| `history[]` | prompt-behaviour metrics `:185` only |
| `pr_history[]` | overview `:213`: only the last entry's `merged`. `pr_number`, `branch`, `created_at`, `merged_at`: nobody, though the PIR review prompt (`pir/prompts/review.md:136`) says status views need `pr_number` |
| `started_at` | overview `:121`, into BuilderCard elapsed |
| `updated_at` | workspace recover `:269`, `:360` |
| `pr_ready_for_human` | overview `:124` parses it; `derivePrReady` (`:447`) ignores it by design (#927). Effectively nobody |
| `build_complete`, `force_advanced`, `context_refreshes`, `context`, `awaiting_input*` | **nobody** |
| `OverviewBuilder.gates` (the full map sent to clients, `api.ts:181`) | **no client** |

Fields that drive behaviour outside porch: `id`, `protocol`, `phase`, the three gate fields,
`started_at`. Fields that drive minor features: `plan_phases`, `current_plan_phase`, `iteration`,
the last `pr_history.merged`, `updated_at`, `history`. Everything else is read only by porch.

## 12. What each group would need, in short

- **Porch absent.** The UIs need a replacement record of *gate requested* and *gate approved*. That
  record is what gate rows, toasts, the Approve command, the Stream Deck key and `afx status`'s
  Gate column read. Without one, they fall back to the soft row and show no gates. Phase-based
  features (stage grouping, progress, finished-lane suppression, workspace recover's terminal
  test) need some "phase" or "finished" signal, or they degrade to `unknown` / 0. Every role,
  prompt, skill and re-entry text that says `porch next` / `porch done` needs rewording. That is
  the largest surface by count: section 9 alone runs to more than eighty line references. The two
  porch modules other code imports (`artifacts.ts` for spec lookup, `protocol.ts` for progress)
  must move. `codev check pr`'s porch-commit skipping becomes unnecessary.
- **Porch smaller (state + gates + records).** Gate-based UI keeps working unchanged. Phase-based UI
  works only if a kept command still writes `phase`. The texts that break are the ones that drive
  the loop (`porch next`, `porch done` as advance, the refresh trigger), and the plan template's
  phases JSON. Two metrics lose their source for new projects (prompt-behaviour metrics from
  `history`; consult output naming from `iteration`). `codev check pr` still needs its porch-commit
  skip, because a smaller porch still commits state to the branch.

## 13. What this survey does not cover

- Adopters' own tooling. Workspaces outside this repository may read `status.yaml` or call porch.
  Several issues are field reports from such workspaces.
- Runtime behaviour. Consumers were read, not run. A consumer that reads a field through a path
  not visible to grep (a computed key, say) could be missed.
- Tests. Test files that read porch state were noted but not listed, and are not consumers in
  production.
- Effort. "Needs rewording" and "needs a gate record" are not sized here.
