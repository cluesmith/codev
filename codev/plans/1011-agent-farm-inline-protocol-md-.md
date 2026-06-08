# PIR Plan: Deliver framework files via resolver-aware channels (fresh-install class fix)

> **Scope note (2026-06-08):** Issue #1011 was expanded mid-plan from "inline protocol.md
> at spawn" to the whole class of framework-file literal-path references reachable from
> builder-side consumers (sub-cases A.1 / A.2 / A.3). This plan supersedes the original
> narrow version. Patch 1 (A.1) is already implemented and sitting at the `dev-approval`
> gate; this revision adds Patch 2 (A.2) and the A.3 disposition. The project-bootstrap gap
> (`codev/resources/` not created on init) is explicitly **out of scope** (separate issue).

## Understanding

Spec 618 moved framework files into the package skeleton (resolver tier 4). The resolver
(`resolveCodevFile`, `skeleton.ts:63`) reaches them correctly. The bug is **consumer-side**:
prompts, role docs, and protocol docs reference framework files by **literal path**, which a
raw shell `cat`/`cp` cannot resolve when the file lives only in the embedded skeleton (fresh
post-618 installs). The builder hits "No such file" and wastes turns hunting.

Three observed sub-instances:

- **A.1 — protocol meta-doc.** All 9 `builder-prompt.md` files instruct `codev/protocols/<name>/protocol.md`; `roles/builder.md:83` has a literal `cat codev/protocols/spir/protocol.md`.
- **A.2 — template references.** 4 references to `codev/protocols/<name>/templates/<file>`:
  - `spir/prompts/plan.md:79`, `aspir/prompts/plan.md:79` — "Use the plan template … if available"
  - `experiment/protocol.md:40` — `cp codev/protocols/experiment/templates/notes.md notes.md`
  - `spike/protocol.md:55` — "Use the template: `…/templates/findings.md`"
- **A.3 — workflow-reference.** `spir/protocol.md:7` (`> Quick Reference: See codev/resources/workflow-reference.md …`). Once A.1 delivers protocol.md inline, this pointer rides along and itself bypasses the resolver.

### Key investigation finding (drives decision #2)

The 4 A.2 references are **heterogeneous**:
- `spir`/`aspir` plan prompts **already embed** a self-contained `### Plan Structure` block
  (`spir/prompts/plan.md:81+`) — a *different, simpler* layout than the 184-line canonical
  `templates/plan.md`. The "if available" pointer is **redundant chrome**, not load-bearing.
- `experiment` (`notes.md`, 97 lines) and `spike` (`findings.md`, 67 lines) reference
  **genuine content** with no inline equivalent in their protocol.md.

This is why **explicit-embed (B) is correct and auto-detect (A) is wrong**: an auto-inliner
would deliver the 184-line canonical plan template *on top of* the prompt's existing
`### Plan Structure`, giving the builder two conflicting plan layouts. A human embedder drops
the redundant pointer and embeds only genuine content; a regex cannot make that distinction.

## Locked Decisions (the 5 plan-gate decisions)

**1 — Delimiter / heading format.**
- Patch 1 (protocol.md): `\n\n---\n\n## Protocol Reference (full text)\n\n<contents>` (already implemented).
- Patch 2 embeds (experiment/spike): under a clearly fenced sub-section adjacent to the
  reworded instruction, e.g.:
  ```
  > The following is the embedded copy of the <name> template, delivered inline so you do
  > not need to fetch a file. Recreate the target file from this content.

  <!-- BEGIN EMBEDDED TEMPLATE: protocols/<name>/templates/<file> -->
  <template contents>
  <!-- END EMBEDDED TEMPLATE: protocols/<name>/templates/<file> -->
  ```
  The `BEGIN/END … <path>` sentinels double as the anchor for the drift-guard test (below).

**2 — A.2 mechanism: Option B (explicit-embed). [agree with architect, strengthened]**
Sub-handled by reference kind (per the investigation finding):
- `spir/prompts/plan.md:79` + `aspir/prompts/plan.md:79` → **drop the redundant pointer line**
  (the prompt's `### Plan Structure` is already self-contained). No embed.
- `experiment/protocol.md:40` → reword the `cp` step to "create `notes.md` from the embedded
  template below" + embed `notes.md` content under the sentinel block.
- `spike/protocol.md:55` → reword to "use the embedded template below" + embed `findings.md`.
Rationale beyond the architect's (static refs / simple runtime / readable prompts): auto-detect
would double-deliver a conflicting plan layout for spir/aspir. B also turns out *cheaper* than
the 40–100-line estimate feared — the 184-line plan template is dropped, not duplicated; only
`notes.md` (97) + `findings.md` (67) are embedded.

**3 — A.3 disposition: Option 2 (strip). [agree with architect]**
Remove the `> Quick Reference: See codev/resources/workflow-reference.md …` line from
`spir/protocol.md`. Informational chrome the protocol works fine without; stripping removes a
known fail-source at zero risk. The `roles/architect.md:5` reference (architect-side consumer)
stays out of scope.

**4 — Resolve-failure behavior: silently skip + `logger.debug` (no stderr warn).**
Rationale: (a) `validateProtocol()` already `fatal()`s earlier if both `protocol.json` and
`protocol.md` are absent, so the Patch-1 inline never silently no-ops in practice; (b) A.2 is
explicit-embed (no runtime resolution to fail); (c) the A.2 source phrasing is literally
"if available" — absence is a *normal, expected* state there, so a warning would be noise.

**5 — Inline is always-on, not config-gated.** No scenario wants a builder without its own
protocol doc; a flag would be dead configuration. State it; no flag added.

## Proposed Change

### Patch 1 — Spawn-time protocol.md inline (A.1) — DONE, at dev-approval

`loadBuilderPromptTemplate()` (`spawn-roles.ts`) resolves `protocols/${protocolName}/protocol.md`
via `resolveCodevFile` and appends it under the Protocol Reference delimiter; `logger.debug`
+ skip when absent. Protocol-agnostic — covers all 9 `builder-prompt.md` refs and the
`roles/builder.md:83` cat (the builder already holds the content when it would have cat'd; per
decision, the illustrative cat line in the role doc is left as-is, not edited).

### Patch 2 — Template embeds (A.2) — explicit-embed, markdown-only (0 LOC code)

- Drop the redundant template pointer in `spir/prompts/plan.md` and `aspir/prompts/plan.md`.
- Embed `notes.md` into `experiment/protocol.md` (reword the `cp` step).
- Embed `findings.md` into `spike/protocol.md` (reword the use-template step).

### A.3 — strip the workflow-reference pointer from `spir/protocol.md`.

### Tree scope: edit **both** `codev-skeleton/` (the shipped source, required for the
fresh-install fix + the repro test) **and** the local `codev/` copies (this repo dogfoods;
its `codev/` shadows the skeleton, so leaving it stale would drift our own instance). Patch 1
needs no markdown edits in either tree (resolver-mediated code).

## Files to Change

- `packages/codev/src/agent-farm/commands/spawn-roles.ts` — Patch 1 (done).
- `packages/codev/src/agent-farm/__tests__/spawn-roles.test.ts` — Patch 1 tests (done) + no new code path for Patch 2.
- `{codev-skeleton,codev}/protocols/spir/prompts/plan.md` — drop redundant template pointer.
- `{codev-skeleton,codev}/protocols/aspir/prompts/plan.md` — drop redundant template pointer.
- `{codev-skeleton,codev}/protocols/experiment/protocol.md` — embed `notes.md`, reword `cp`.
- `{codev-skeleton,codev}/protocols/spike/protocol.md` — embed `findings.md`, reword.
- `{codev-skeleton,codev}/protocols/spir/protocol.md` — strip workflow-reference line (A.3).
- `packages/codev/src/.../__tests__/` — new content-guard test (see Test Plan).

## Risks & Alternatives Considered

- **Risk: embedded template drifts from canonical `templates/*.md`.** Mitigation: a unit test
  asserts the embedded block (between the `BEGIN/END EMBEDDED TEMPLATE` sentinels) byte-matches
  the canonical template file. Drift fails CI. Applies to `notes.md` and `findings.md`.
- **Alternative: A.2 = auto-detect (Option A).** Rejected — would double-deliver a conflicting
  plan layout for spir/aspir (see finding) and needs traversal in two channels (porch
  `loadPromptFile` + spawn inline). B is simpler, correct, and human-discriminating.
- **Risk: residual single failed `cat`.** With Patch 1 leaving the builder-prompt's "read
  protocol.md" instruction intact (per the rejected-alternative "drop the instructions" —
  ruled out for per-protocol audit cost), an eager builder *could* still `cat` once before
  noticing the inlined copy. Accepted: the content's presence prevents the multi-minute *hunt*
  (the actual symptom); the clear `## Protocol Reference` delimiter (decision #1) mitigates
  "louder than the per-phase prompt" confusion. Flagged for the dev-approval check.
- **Observed but out of scope:** additional *relative-path* template refs inside protocol.md
  (`spir/protocol.md:215` `templates/spec.md`, `:301` `templates/plan.md`,
  `experiment/protocol.md:90` `templates/notes.md`). Relative + informational; not in the
  architect's enumerated A.2 set. Left as-is unless you want them folded in.

## Test Plan

**Automated (in `npm test` → `@cluesmith/codev`):**
- Patch 1 (exist): protocol.md inlined under the delimiter; omitted without error when absent.
- A.2 content guard (new): load `spir/prompts/plan.md` + `aspir/prompts/plan.md` from the
  skeleton; assert the dead template-path pointer is **absent** and the self-contained
  `### Plan Structure` is **present**. Load `experiment/protocol.md` + `spike/protocol.md`;
  assert the embedded template block is present **and byte-matches** the canonical
  `templates/notes.md` / `templates/findings.md` (drift guard).
- A.3 guard (new): assert `spir/protocol.md` no longer references `workflow-reference.md`.

**Build:** `npm run build` from worktree root.

**Manual (dev-approval, load-bearing — repro from issue):** fresh `codev init` in a tmp dir,
spawn a test PIR builder, run through plan + implement; confirm (a) no file-hunting for
protocol.md OR templates, (b) the builder still follows per-phase prompts (inlined material
not "louder"), (c) per-phase templates land in the right phase. PR-diff review can't catch these.
