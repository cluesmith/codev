# Rebuttal — Phase 4 (Builder context resolution), iteration 1

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

All four findings accepted — two blocking from Codex, two non-blocking from Claude. Notably, Codex and
Claude **independently identified the same first defect**, which raised my confidence that it was real
rather than a reviewer preference.

---

## Codex — REQUEST_CHANGES

### Issue 1: "The resolved context does not carry the full phase-4 deliverable shape"

**Accepted.** The plan states phase 4 resolves `{ protocol, phase, mode, harness, specName, planPath, issue }`.
`ResolvedBuilderContext` carried protocol, mode, harness, porch and a pass-through `issueNumber` —
`specName` and `planPath` were simply absent, and `issue` was forwarded rather than resolved.

This is not a cosmetic shape mismatch. Phase 5's whole design is that the long-form re-orientation is
`buildPromptFromTemplate`'s output, which needs a `TemplateContext` carrying the spec and plan paths.
Leaving those out would have pushed the derivation into phase 5, where it would sit next to prompt
assembly instead of next to the other worktree-reading logic — and phase 5's job is to *fail loudly on a
missing field*, not to go looking for one.

**Changed** — `artifactPaths()` derives them from the porch project name (porch names its project dir
`<id>-<title>`, and spec/plan files share that stem):

- `specName`, `specPath`, `planPath` added to `ResolvedBuilderContext`.
- Paths are returned **only when the file exists**, else null. A pointer to a nonexistent plan would send
  a freshly-reset builder — one with no memory to cross-check against — chasing a ghost.
- All three are null on a non-porch lane, where no naming convention applies.
- `issueNumber` now resolves as `issueNumber ?? porch.projectId`: issue-driven protocols name the porch
  project after the issue, so the project id is correct when the registry row carries none.

### Issue 2: "Harness lookup is hard-coded to BUILTIN_HARNESSES, bypassing custom providers"

**Accepted.** `.codev/config.json` can define custom harnesses, and `resolveHarness` honours them. My
scanner only knew builtin names, so a builder launched with a custom harness failed as *"no recognisable
launch command"*.

The user-visible consequence is what makes this worth fixing: that message sends the project to debug its
`.codev/config.json` for a config that is in fact correct. The accurate refusal is *this harness cannot
clear context in-session*.

**Changed** — `harnessFromLaunchScript` and a new `harnessProviderFor` both accept the custom-harness map,
so a custom harness is recognised, mapped to a real provider via `buildCustomHarnessProvider`, and then
capability-checked. Because `buildCustomHarnessProvider` does not set `supportsContextReset`, custom
harnesses remain unsupported by default — the safe direction. Letting one *declare* support would be a
one-field addition to `CustomHarnessConfig`; deliberately out of scope, and noted in the code.

---

## Claude — APPROVE, three non-blocking observations (all acted on)

### 1. `specName` / `planPath` absent

Same defect as Codex issue 1, found independently. Fixed as above. Claude judged it non-blocking on the
grounds that phase 5 could derive them itself; I treated it as blocking because the plan assigns the
derivation to phase 4 and because keeping worktree-reading in one module is what lets phase 5 be a pure
complete-or-abort assembler.

### 2. Double `status.yaml` read

**Accepted.** `protocolFromStatus` and `readPorchContext` each scanned the project dirs and read the same
file. Claude called it style; I fixed it for a correctness reason it did not mention: two independent
scans could in principle disagree about *which* status.yaml is authoritative if a worktree ever held more
than one project directory. `protocolFromStatus` now delegates to `readPorchContext`, and `protocol` moved
onto `PorchContext`, so there is a single answer by construction.

### 3. `harnessFromLaunchScript` could false-positive on a conditional

**Accepted, and this was the most valuable observation of the round.** Claude noted that a future launch
script containing `if [ "$HARNESS" = "codex" ]` would match `codex` by substring and return the wrong
harness.

That is not a harmless misread. Naming the wrong harness either refuses a builder that *could* be reset,
or — the dangerous direction — approves typing `/clear` into a builder whose harness has no in-session
reset, where the keystrokes land as literal text in a live agent's prompt.

**Changed** — detection now matches on **command position** rather than searching the line. A new
`commandNameOf()` strips shell control keywords (`while`, `if`, `exec`, …) and leading `VAR=value`
assignments, takes the first token, and basenames it. Five tests pin the behaviour: a harness named inside
a conditional, a variable assignment, an absolute path, an `exec` + env-var prefix, and a comment.

---

## Gemini — APPROVE

No issues raised.

---

## Net effect

Two production defects fixed (incomplete context shape, custom-harness blindness), one latent
false-positive surface closed, one duplicate scan removed. Tests 24 → 38.
