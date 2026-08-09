# Rebuttal — Phase 5 (Re-orientation assembly), iteration 3

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

Both of Codex's points accepted. Both hold the frame to wording I wrote in the spec and then did not
implement.

---

## Codex — REQUEST_CHANGES

### Issue 1: "The identity block never says which role document governs the builder"

**Accepted.** The spec's description of the inline identity block is explicit: it must convey *"that the
recipient is a builder **and which role document governs it**"*. The frame said:

> You are a Builder (your role document governs you and is still in effect).

That satisfies the first half and gestures at the second. The gesture is worthless to the actual reader:
a builder whose conversation has just been cleared has no way to resolve "your role document" to a file.
Naming it is the entire point of the requirement.

**Changed** — the identity block now names `.builder-role.md` at the worktree root, which is the concrete
artifact the harness injected at spawn (rather than a `codev/roles/...` path that resolves through the
four-tier chain and may not exist on disk in the worktree). `.builder-role.md` was added to
`REQUIRED_INLINE_MARKERS`, so it cannot be dropped by a later edit without failing assembly.

### Issue 2: "Only the derived directory stem is emitted, not explicit project id"

**Accepted.** The frame carried `Project: 1273-builder-context-reset-should-b` — the porch project
directory name. The id is *inside* that string, but never labelled.

Concretely: `porch status <id>` and `porch next <id>` take the id. A reset builder reading only the stem
has to infer that the leading numeric segment before the first hyphen is the project id — an inference
about a naming convention, made by an agent that has just lost all its context. Stating it costs one line.

**Changed** — `Project ID:` is now emitted explicitly in the inline frame and `Porch project ID:` in the
long form, and `Project ID:` joined the conditional required markers for porch lanes.

### On both tests "locking in the weaker behaviour"

Codex is right about this and it is the second time in this phase. The tests asserted `Project:` and
`You are a Builder` — exactly what the code produced — so they would have passed indefinitely with both
gaps present. This is the same failure as the earlier marker-list problem: **tests written from the
implementation confirm the implementation.** The corrective is to write frame assertions from the spec's
wording, which is what the new tests do (`Project ID: 1273`, `.builder-role.md`, `Porch project ID: 1273`).

Logged for the review's lessons — it has now caused three separate defects in this project.

---

## Gemini — APPROVE

No issues raised.

## Claude — APPROVE

No issues raised; noted the deviation documented in the iteration-1 rebuttal (verbatim resume notice in
the long form rather than inline) as transparently recorded.

---

## Net effect

Two spec-conformance gaps closed in the identity/project frame; two tests added, one strengthened.
Tests 40 → 42.
