# Spec 1280 — retirements register

Every entry here is an assertion or capability this project **removed rather than preserved**.
M5 and M10 both hard-fail on an unlisted removal, so an entry is only valid with the originating
spec named, the behaviour analysis stated, and **architect approval recorded**.

Nothing in this file is self-approved.

---

## R1 — `expectPureAdditionDiff` on the three builder-prompts

**Status: APPROVED by the architect, 2026-08-01. Applied.**

| | |
|---|---|
| **Assertion** | `baked-decisions.test.ts` → *"pure-addition diff: baseline lines are preserved in order"* |
| **Files** | `codev/protocols/{spir,aspir,air}/builder-prompt.md` |
| **Originating spec** | **Spec 746 — Baked Architectural Decisions** |
| **Baselines** | `fixtures/baselines/{spir,aspir,air}-builder-prompt.md.baseline` (113 lines each, **pre-746**) |

### What it protects, exactly

The baseline is the **pre-746** file. `expectPureAdditionDiff` walks the baseline and requires
every line to reappear, **in order**, in the current file. It therefore proves one thing:

> *Spec 746's Baked Decisions paragraph was **added** without destroying any prior content.*

A **pollution check** guards the guard: the baseline must **not** contain `## Baked Decisions`.
That catches the failure mode where someone re-captures the baseline after their own edit,
making the invariant vacuous. It is good design, and it is what stops me taking the easy route
here.

### Why it cannot survive Spec 1280

Spec 1280 **deliberately deletes** prose from these prompts. The invariant "no pre-746 line was
ever removed" is now false by design, and permanently so: it forbids *any* future rewrite of
these files, not just this one. It was built for an additive change and cannot express a
subtractive one.

Re-baselining to the current file does not rescue it — the new baseline would contain
`## Baked Decisions`, and 746's pollution check would (correctly) fail. **Silencing that check to
make the re-baseline pass would gut the anti-vacuity property**, which is the more valuable half
of 746's protection. I am not proposing that.

### Does the protected behaviour survive?

**Partly, and the split matters:**

| 746 protected | Survives? | Evidence |
|---|---|---|
| Baked Decisions **content present** in all three prompts | **YES — unchanged** | `## Baked Decisions` heading, the `do not autonomously` carveout, the contradiction-handling wording, and mirror-parity across `codev/` ↔ skeleton all still assert and **pass** |
| **No prior content deleted** | **NO — deliberately** | This is the project |

So 746's *substance* is intact and still guarded. What is being retired is the **no-deletion**
property, which Spec 1280 exists to violate.

### Correction to this document

An earlier revision of this entry described the replacement guard as *"implemented, inert until
approved"*. **It was not implemented** — it was designed and described. The architect read and
approved this file partly on its contents, so the overstatement is corrected here rather than
quietly fixed. The replacement ships as its own commit, separate from the retirement, per the
approval's third condition.

### Replacement guard (ships separately)

`spec-1280-prompt-deletion-guard.test.ts` — the same machinery, re-anchored:

- **Post-1280 baselines**, captured from the rewritten prompts.
- Pure-addition against those, so **future** silent deletion is still caught — the guard keeps
  working going forward, it just stops asserting a state this project intentionally left.
- Its own anti-vacuity check, inverted for the new era: the post-1280 baseline **must** contain
  `## Baked Decisions`. If a later edit strips 746's content and someone re-baselines to hide
  it, that check fails.

Net effect: 746 keeps its content guarantee and gains a deletion guard that survives rewrites,
instead of one that forbids them.

### Behaviour-re-asserted mapping (approval condition 2)

One row per retired assertion. "Still asserted by" names the *surviving* test that carries the
behaviour, so a future reader can check the claim rather than trust it.

| Retired assertion | Behaviour it carried | Survives? | Still asserted by |
|---|---|---|---|
| `codev SPIR builder-prompt: post-edit file is a pure-addition diff of its baseline` | (a) 746's paragraph present; (b) no pre-746 line ever deleted | (a) **yes** / (b) **no, by design** | (a) `contains the "## Baked Decisions" heading`, `uses the carveout phrasing "do not autonomously"`, contradiction-handling and mirror-parity assertions — all passing unmodified |
| `codev ASPIR builder-prompt: post-edit file is a pure-addition diff of its baseline` | same | same | same, plus `bugfix-619-aspir-prompt.test.ts` (`Follow the ASPIR protocol`, no `protocol.md` reference) |
| `codev AIR builder-prompt: post-edit file is a pure-addition diff of its baseline` | same | same | same |

**Anti-vacuity preserved**: the pollution check (`baseline does NOT contain '## Baked
Decisions'`) is **untouched and still passing**. It is the half of 746's protection that stops a
future builder silently re-baselining away the guarantee, and retiring the pure-addition half
does not weaken it.

**Not retired, explicitly**: the identical `expectPureAdditionDiff` guards over `PHASE_2_FILES`
(drafting prompts) and `PHASE_3_FILES` (reviewer prompts) remain in force. This retirement is
scoped to the three builder-prompt instances only.

### Architect decision

- [x] **APPROVED — 2026-08-01.** Grounds, recorded as given:
  1. The invariant is **construction-time scaffolding that hardened into a change-freeze** — it
     proved 746's paragraph was added non-destructively *at the moment of addition*, but as a
     standing assertion it forbids any future deletion-rewrite of those files forever, which is
     **not a behaviour 746 ever claimed to protect**.
  2. 746's actual protection — the Baked Decisions sections present and substantive, plus the
     anti-vacuity pollution check — **survives in the assertions that still pass unmodified**.
  3. The analysis that re-baselining guts the anti-vacuity half is **verified sound**, so
     retirement-with-trace is strictly more honest than the silent re-baseline a less careful
     builder would have shipped.

---

## R2 — `expectPureAdditionDiff` on the two SPIR/ASPIR `specify.md` drafting prompts

**Status: PROPOSED, Phase 5, 2026-08-02. Awaiting architect approval. Nothing applied; the suite
is deliberately left RED on these two assertions until a decision is recorded.**

This is the retirement **R1 explicitly foresaw**: R1 closed by scoping itself to the three
builder-prompts and stating *"the identical `expectPureAdditionDiff` guards over `PHASE_2_FILES`
(drafting prompts) and `PHASE_3_FILES` (reviewer prompts) remain in force."* Phase 5 is the phase
that rewrites `specify.md`, so its `PHASE_2_FILES` pure-addition guard now hits the same wall.

| | |
|---|---|
| **Assertion** | `baked-decisions.test.ts` → Phase 2 *"pure-addition diff: baseline lines preserved in order"* |
| **Files (2 of 3)** | `codev/protocols/{spir,aspir}/prompts/specify.md` |
| **NOT in scope** | `codev/protocols/air/prompts/implement.md` — Phase 5 does not touch it; its baseline stays in force |
| **Originating spec** | **Spec 746 — Baked Architectural Decisions** |
| **Baselines** | `fixtures/baselines/{spir,aspir}-specify.md.baseline` (**pre-746**) |

### Why it cannot survive Spec 1280 (same shape as R1)

The baseline is the **pre-746** `specify.md`, carrying the whole verbose "Process" walkthrough
(the numbered steps, "Check for Existing Spec (ALWAYS DO THIS FIRST)", etc.). Phase 5's P1/P2
rewrite **deletes that prose by design**, converting step-by-step procedure into a
"What must be true when you finish" contract. So "no pre-746 line was ever removed" is now false
by design, and permanently — it forbids any future rewrite of `specify.md`, exactly the
change-freeze failure mode R1 named. Re-baselining is rejected for R1's reason: the new baseline
would contain `Baked Decisions`, and 746's pollution check (`spir-specify.md.baseline` must NOT
contain `Baked Decisions`) would correctly fail; silencing it would gut the anti-vacuity half.

### Does the protected behaviour survive?

**Yes — the Baked Decisions substance is intact and still guarded.** The wording was restored to
the canonical carveout form in this same phase, so every *behaviour* assertion passes unmodified:

| 746 protected | Survives? | Evidence (all passing) |
|---|---|---|
| Baked Decisions **content present** in specify.md | **YES** | grep: `Baked Decisions`, `do not autonomously`, `contradict`+`pause`+`flag`, `afx send` — all pass on both trees |
| clause **byte-identical across codev/ ↔ skeleton** | **YES** | Phase 2 mirror-parity assertions pass |
| baseline **anti-vacuity** (pollution check) | **YES — untouched** | `spir-specify.md.baseline does NOT contain "Baked Decisions"` still passes |
| **no prior content deleted** | **NO — by design** | this is the phase |

### Replacement guard (ships on approval, separate commit — mirrors R1)

Extend the existing `spec-1280-prompt-deletion-guard.test.ts` (R1's replacement) to cover the two
post-1280 `specify.md` files:

- **Post-1280 baselines** captured from the rewritten `specify.md` prompts.
- Pure-addition against those, so **future** silent deletion of the Baked Decisions content is
  still caught going forward.
- Inverted anti-vacuity: the post-1280 baseline **must** contain `Baked Decisions`; a later edit
  that strips 746's content and re-baselines to hide it fails the guard.

Net effect identical to R1: 746 keeps its content guarantee and gains a deletion guard that
survives rewrites, instead of one that forbids them.

### Behaviour-re-asserted mapping

| Retired assertion | Behaviour it carried | Survives? | Still asserted by |
|---|---|---|---|
| `codev SPIR specify.md: post-edit file is a pure-addition diff of its baseline` | (a) 746's clause present; (b) no pre-746 line deleted | (a) **yes** / (b) **no, by design** | (a) Phase 2 grep (`Baked Decisions`, `do not autonomously`, `contradict`+`pause`+`flag`, `afx send`) + mirror-parity — all passing |
| `codev ASPIR specify.md: post-edit file is a pure-addition diff of its baseline` | same | same | same |

**Anti-vacuity preserved**: the pollution check is untouched and passing. **Still in force,
explicitly**: the `PHASE_2_FILES` pure-addition guard over `air/implement.md`, and all
`PHASE_3_FILES` reviewer-prompt guards. This proposal is scoped to the two specify.md instances
Phase 5 actually rewrote.

### Architect decision

- [ ] **PENDING.** Rejection is a legitimate outcome — it means Phase 5 cannot rewrite the two
  `specify.md` files to P1/P2 and that decision is rescoped to leave them pure-addition.
