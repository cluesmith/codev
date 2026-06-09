# PIR Plan: Deliver framework files via resolver-aware channels (fresh-install class fix)

> **Scope history (2026-06-08):** #1011 grew from "inline protocol.md at spawn" → a
> framework-file class fix → its current **three-layer** form (Delivery / Cleanup /
> Enforcement). This plan tracks the three-layer body. Patch 1 (Layer 1 / A.1) is already
> implemented and at the `dev-approval` gate; this revision folds in the rest. `codev read`
> CLI is **explicitly rejected** — not proposed. Project bootstrap of `codev/resources/` is
> **#1012** (out of scope here).

## Understanding

Spec 618 moved framework files into the package skeleton (resolver tier 4). `resolveCodevFile`
(`skeleton.ts:63`) reaches them. The bug is **consumer-side**: prompts, role docs, and protocol
docs reference framework files by **literal path**, which a raw shell `cat`/`cp` can't resolve
when the file lives only in the embedded skeleton (fresh post-618 installs). The builder hits
"No such file" and wastes turns. Three sub-instances: A.1 (protocol.md from 9 builder-prompts +
`roles/builder.md:83` cat), A.2 (4 template refs), A.3 (workflow-reference inside `spir/protocol.md`).

### Investigation findings that drive the decisions

1. **A.2 references are heterogeneous** — and the `spir`/`aspir` plan case was initially
   mis-read. The plan prompt's inline `### Plan Structure` was a *simpler, JSON-less* layout, so
   I first treated the `templates/plan.md` pointer as redundant chrome and dropped it. **That was
   wrong**: porch's plan gate requires the **machine-readable phases JSON** (`has_phases_json` +
   `min_two_phases`), which lives *only* in `templates/plan.md` — so the pointer was load-bearing.
   Corrected by delivering `templates/plan.md` via a `{{> }}` include (see decision #2). The
   `experiment` (`notes.md`, 97L) and `spike` (`findings.md`, 67L) templates are likewise genuine
   content delivered via include.
2. **`bugfix` ships no `protocol.md` in the skeleton** (only `protocol.json` + prompts), yet its
   `builder-prompt.md:28` references one, and the local `codev/` tree carries a real **548-line**
   `bugfix/protocol.md` that was *never tracked in the skeleton*. So Patch 1 cannot inline for
   bugfix, and after Layer 2 drops the pointer, bugfix would have **no meta-doc at all** in fresh
   installs. See "Open sub-decision" below — this needs an explicit call.
3. **Embedded `notes.md`/`findings.md` contain zero `{{`**, so inlining them through
   `renderTemplate` (they ride inside `experiment`/`spike` `protocol.md`) is collision-safe.
4. **`experiment`/`spike` default to `mode: soft`** (verified in `protocol.json`: every phase is
   `prompt: None`, `prompts/` is empty). Soft mode has no porch phase orchestration — the builder
   follows `protocol.md` directly — so `protocol.md` is their *only* guidance channel. This is the
   reason templates are injected into `protocol.md` for these two (and not for the strict,
   phase-prompt-driven protocols). It also means "no phase prompts" is by-design, not a defect.

## Locked Decisions (the 5 plan-gate decisions)

**1 — Delivery: fresh-at-delivery placeholder substitution (NOT a committed copy).**
*(Revised at the dev-approval gate: the earlier static-embed committed a duplicate that would go
stale; the reviewer rejected it.)*
- protocol.md: the builder-prompt `## Protocol` section keeps "Follow the X protocol. Read and
  internalize the protocol before starting any work." and references the full text below. A
  `{{protocol_reference}}` placeholder near the end of the prompt is filled **fresh at spawn** by
  reading `protocol.md` through the resolver, so nothing is committed into `builder-prompt.md` (no
  stale copy). The reference is **unconditional** (no `{{#if}}` guard): every shipped protocol
  ships a `protocol.md` (bugfix got one in #1013), and a unit test enforces that invariant so a
  future `protocol.json`-only protocol fails CI rather than rendering an empty section. (An earlier
  iteration wrapped it in `{{#if protocol_reference}}`; removed once the completeness invariant was
  made explicit — the guard was always-true for the shipped set and read as dead code.)
- Templates (experiment/spike): the `## Template:` section in `protocol.md` carries a
  `{{> protocols/<name>/templates/<file>}}` include directive, resolved fresh (recursively, while
  building `{{protocol_reference}}`). The canonical `templates/*.md` stays single-source.

**2 — A.2 mechanism: fresh-at-delivery `{{> }}` include, on BOTH delivery channels.**
Every genuine template is delivered via a `{{> path}}` include resolved fresh by the shared
`resolveCodevIncludes` (in `lib/skeleton.ts`), which now runs in **both** channels:
- **spawn** — `resolveProtocolReference` resolves includes inside `protocol.md` (experiment/spike
  `## Template:` sections → `notes.md` / `findings.md`).
- **porch phase prompts** — `loadPromptFile` now resolves includes too, so `spir`/`aspir`
  `prompts/plan.md` use `{{> protocols/spir/templates/plan.md}}` to deliver the canonical plan
  template (with its required machine-readable phases JSON) fresh at the plan phase.

The earlier "drop the spir/aspir plan pointer; the inline `### Plan Structure` is self-contained"
call was **reverted** — that inline block lacked the porch-required JSON (finding #1). The
divergent inline `### Plan Structure` is removed; the canonical `templates/plan.md` is the single
source, delivered via the include. Auto-detect (blanket scan) is still rejected; the include is
explicit (the author marks exactly what to inline), single-source, and never a committed copy.

**Why inject for experiment/spike but not spir/aspir — the distinction is `mode`, not ad-hoc
(finding #4):** `experiment` and `spike` default to **`mode: soft`** (verified in their
`protocol.json`; every phase is `prompt: None`, `prompts/` is empty). Soft mode has **no porch
phase-by-phase orchestration** — the builder follows `protocol.md` directly — so `protocol.md`
is the *only* guidance channel and the template structure must ride it. The `{{> }}` include is
therefore the correct delivery for a soft-mode protocol (fresh, no stale committed copy). By
contrast `spir`/`aspir`/`bugfix` are **strict** (porch-orchestrated): their phase prompts carry
the structure, so injecting a template would double-deliver — hence we drop the dead pointer
instead. Net: strict → phase prompts carry structure (don't inject); soft → `protocol.md` is
everything (inject). This also retires the earlier "give experiment/spike phase prompts" idea:
phase prompts are a strict-mode concept; soft-mode protocols correctly live in `protocol.md`, so
no such follow-up is needed.

**Bug impact for experiment/spike (was real, now fixed):** before this work, a soft-mode
experiment/spike builder following `protocol.md` in a fresh install hit a dead template path
(`cp codev/protocols/experiment/templates/notes.md …` / "use the template at `…/findings.md`") —
the file isn't on disk. The `{{> }}` injection delivers the template content inline at spawn, so
the dead path / failed `cp` is gone. These protocols are fixed by this PR, not left broken.

**3 — A.3 disposition: Option 2 (strip). [agree]**
Remove the `> Quick Reference: See codev/resources/workflow-reference.md …` line from
`spir/protocol.md`. Informational chrome; zero-risk removal. `roles/architect.md:5` stays out.

**4 — Missing-framework-file behavior: silently skip + `logger.debug` (no stderr warn).**
The skip is a **routine, by-design state**: `bugfix` has no skeleton `protocol.md`, so Patch 1's
resolve returns null and skips on every bugfix spawn (`validateProtocol` only `fatal()`s when
*both* json and md are absent). A stderr warn would fire on every bugfix spawn about an
intentionally-absent file. A.2 = embed (no runtime resolution to fail). Skip + debug it is.

**5 — Doctor check: warn-not-error, scans the WORKSPACE `codev/` overrides. [revised — was
"skeleton-only"]**
`codev doctor` is an end-user tool, so its check targets what the *user* controls and could
break: their local `codev/protocols` and `codev/roles` overrides. It scans the workspace `codev/`
dir (not the global package skeleton) for shell-fetch verbs reading `codev/(protocols|roles)/…md`,
reports `status: 'warn'` (never `'fail'`), and is a no-op when the project has no overrides.
*Correction:* the original "skeleton-only" framing was wrong — auditing the shipped package
skeleton from an end-user tool is pointless (the user can't fix it, and it's already guaranteed
clean by the framework's own CI). The shipped-skeleton guard lives in the **unit test**
(`framework-ref-audit.test.ts` scans `codev-skeleton/`, runs in CI); `codev doctor` guards the
user's overrides. This matches the architect's original Layer 3 intent ("grep … and any local
`codev/` directories"). Relative-path refs and markdown-link cross-references (`templates/x.md`,
the intentional `aspir → spir` link) are a lower-severity class **not** targeted by the
shell-fetch grep — handled by manual audit where they mattered, left where intentional.

## bugfix + experiment doc hygiene — RESOLVED in this PR (was #1013, now folded in)

`bugfix` was the one protocol whose `protocol.md` wasn't in the skeleton (`codev/` had a tracked
548-line copy, never shipped). Worse, that copy was **stale** vs porch orchestration (a manual
`afx send "Merge it"` merge handshake, a manual architect CMAP, and the deprecated projectlist
section) — and Layer 1 now reliably **inlines** `protocol.md` into the builder's prompt wherever
it resolves, so the stale content would land in bugfix builders' context (in this repo, and in
any project that has a bugfix `protocol.md`). That is a correctness risk, not just hygiene.

Resolution (folded in per "implement #1013 so the whole bug ships together"):
- **Rewrote `bugfix/protocol.md`** as a concise (~78-line), porch-accurate doc grounded in the
  real flow (`protocol.json` phases + the `pr` gate; `prompts/{investigate,fix,pr}.md`): the merge
  is gated by the `pr` gate (builder runs CMAP → `porch done` → human approves the gate → porch
  emits the merge task), not a manual handshake. Dropped the projectlist section and fixed the
  branch-naming inconsistency. **Shipped it to the skeleton**, so fresh-install bugfix builders
  get a correct meta-doc (consistent with the other protocols) via Layer 1.
- **Removed `experiment/protocol.md`'s `## notes.md Template` partial copy** (a relative-ref
  duplicate of `notes.md`); the `## Template: notes.md` fresh-include the delivery layer already
  resolves makes it redundant. No committed template copy remains.

(This also retires the latent mixed-audience concern: every protocol now ships a `protocol.md`,
and bugfix's is concise/builder-relevant rather than a stale architect-facing dump.)

## Proposed Change (three layers)

**Layer 1 — Delivery.**
- *Patch 1 (A.1, done):* `loadBuilderPromptTemplate()` inlines `protocol.md` under the delimiter.
- *Patch 2 (A.2):* Option B embeds (per decision 2) — markdown only, 0 LOC code.

**Layer 2 — Cleanup (skeleton sweep).**
- Drop the `Follow the <X> protocol: \`…protocol.md\`` line from all 9 `builder-prompt.md`
  (PIR has two refs: `:30` and the `:90` getting-started line — both go; keep PIR's 3-phase
  breakdown). The protocol text is already in context via Patch 1.
- `roles/builder.md:83`: replace the `cat codev/protocols/spir/protocol.md` example with a note
  that the protocol is inlined in the spawn prompt under `## Protocol Reference`.
- A.2 literal paths leave the four prompts by construction (decision 2).
- A.3: strip per decision 3.

**Layer 3 — Enforcement.**
- *Convention doc:* add a "Framework files: never reference by literal `codev/…` path" section to
  **both** `AGENTS.md` and `CLAUDE.md` (kept in sync, per repo policy).
- *Doctor audit:* add a check to `doctor()` (`packages/codev/src/commands/doctor.ts:539`) mirroring
  the existing `CheckResult`/`printStatus` pattern (decision 5 semantics).

### Tree scope
Edit **both** `codev-skeleton/` (shipped source; required for the fix + repro test) and the
local `codev/` copies (this repo dogfoods; its `codev/` shadows the skeleton). Patch 1 needs no
markdown edits in either tree.

## Files to Change

- `packages/codev/src/agent-farm/commands/spawn-roles.ts` (+ `__tests__/spawn-roles.test.ts`) — Patch 1 (done).
- `{codev-skeleton,codev}/protocols/{spir,aspir}/prompts/plan.md` — drop redundant template pointer (Patch 2 + Layer 2).
- `{codev-skeleton,codev}/protocols/{experiment,spike}/protocol.md` — `{{> ...}}` template include, reword (Patch 2).
- `{codev-skeleton,codev}/protocols/*/builder-prompt.md` (all 9) — drop protocol.md pointer; restore "Read and internalize"; add `{{protocol_reference}}` placeholder (Layer 1/2).
- `{codev-skeleton,codev}/roles/builder.md` — fix the cat example (Layer 2).
- `{codev-skeleton,codev}/protocols/spir/protocol.md` — strip A.3 line (Layer 2).
- `AGENTS.md`, `CLAUDE.md` — convention section (Layer 3).
- `packages/codev/src/commands/doctor.ts` (+ `src/__tests__/doctor.test.ts`) — audit check (Layer 3).
- `{codev-skeleton,codev}/protocols/bugfix/protocol.md` — **new in skeleton**; rewritten concise + porch-accurate (was #1013, folded in).
- `{codev-skeleton,codev}/protocols/experiment/protocol.md` — remove the redundant `## notes.md Template` partial copy (was #1013, folded in).

## Risks & Alternatives Considered

- **Drift:** eliminated by design — templates and protocol.md are delivered via fresh-at-spawn
  placeholder substitution (`{{protocol_reference}}` / `{{> ...}}`), so no duplicate copy is
  committed to drift. A test asserts the include placeholder is present and no static embed
  remains. (Pre-existing, out-of-scope: `experiment/protocol.md` already has a `## notes.md
  Template` section quoting part of `notes.md` via a relative ref — noted, not touched.)
- **Doctor false positives:** scoping the grep to absolute `codev/…` paths (decision 5) keeps it
  aligned with the sweep; relative refs intentionally not matched.
- **Auto-detect (Patch 2 = A):** rejected — double-delivers a conflicting plan layout (finding #1).
- **`codev read` CLI / restore copying / per-`next` injection:** rejected per the issue's table.
- **Residual cat:** eliminated for protocol.md — Layer 2 removes the pointer outright (the earlier
  "leave the instruction" stance is reversed by Layer 2).

## Test Plan

**Automated (`npm test` → `@cluesmith/codev`):**
- Delivery (new): `buildPromptFromTemplate` fills `{{protocol_reference}}` from protocol.md fresh;
  omits cleanly when absent; resolves `{{> ...}}` template includes recursively.
- A.2 guard (new): `spir`/`aspir` `plan.md` no longer reference the template path and still carry
  `### Plan Structure`; `experiment`/`spike` `protocol.md` carry the `{{> ...}}` include and no
  static embed.
- Layer 2 guard (new): no `builder-prompt.md` references `protocol.md`; `roles/builder.md` has no
  `cat codev/protocols/…`; `spir/protocol.md` has no `workflow-reference.md`.
- Layer 3 audit (new, in `framework-ref-audit.test.ts`): flags a shell `cat`/`cp` of a framework
  path (positive), ignores doc references / `codev/resources` / user files (negative), the real
  `codev-skeleton/` source is clean (CI/source guard), and a codev root with no protocol/role
  overrides is a no-op (the `codev doctor` workspace case).

**Build:** `npm run build` from worktree root.

**Manual (dev-approval, load-bearing — issue repro):** fresh `codev init` in a tmp dir, spawn a
test builder, run plan + implement + review; confirm (a) no file-hunting for protocol.md OR
templates, (b) per-phase prompts still followed (inlined material not "louder"), (c) templates
land in the right phase, (d) `codev doctor` catches a deliberately-introduced literal-path ref.
