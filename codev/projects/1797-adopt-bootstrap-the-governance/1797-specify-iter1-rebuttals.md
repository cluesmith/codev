# Spec 1797 — iteration 1 rebuttal

All REQUEST_CHANGES points were accepted; the spec was revised (commit "[Spec 1797] Specification with multi-agent review"). No disagreements.

## Codex

1. **Placeholder-only writes not enforced against the agent.** Accepted. Constraint changed from a guarantee to detect-and-report: pre/post snapshot of the four files and git state (HEAD, index, modified paths); any curated-file change, HEAD/index change, or non-eligible path modified is named with a non-zero exit, never auto-reverted. Scenario 13 + risk row added.
2. **Map rule impossible with >12 cold sections.** Accepted. Map validity is now map→cold (always enforced); full coverage required only when the cold doc has ≤12 top-level sections, otherwise unmapped sections are informational. Bootstrap-authored cold docs are kept to ≤12 top-level sections.
3. **Classifier vs seeded lessons.** Accepted. Exact predicate: every non-blank line appears verbatim in the shipped (current or earlier) starter AND at least one starter marker remains. Seeded lessons are starter content; any added/edited line ⇒ curated. Scenarios 9 and 10.
4. **Harness contract underspecified.** Accepted. Launch is an optional harness capability ("interactive launch with initial task prompt"); supported built-ins verified empirically in the plan; unsupported/missing harness ⇒ prompt written to a file + manual instructions, nothing launched (scenario 15).
5. **Non-empty repository definition.** Accepted. Defined via `git ls-files --cached --others --exclude-standard` (filesystem walk outside git) excluding the Codev-generated set; uncommitted code with no commits counts as non-empty; submodule entries count (scenario 6).
6. **Consult availability/failure/storage.** Accepted. Each reviewer independent; unavailable/failed reviewers named; `consult` entirely unavailable ⇒ warning, pass completes. Feedback saved under `.consult/bootstrap-docs/` (already gitignored, consult-owned), exempt from the change detector.

## Claude

1. **Map coverage not checkable.** Accepted — same fix as Codex 2. Scenario 12 asserts our own `arch-critical.md` (19-section arch.md, 12-topic map) passes.
2. **35-line cap undefined.** Accepted. Cap is section-scoped: ≤10 entries under facts/lessons, ≤12 under the map, ≤35 lines excluding HTML comment lines. The bootstrap keeps the guidance comment minus its `STARTER:` sentence.
3. **Byte-identical can only be detected.** Accepted — criterion reworded as detect-and-report (Codex 1).
4. **Adopt session collision.** Accepted. Awaiting the merge session's exit before the offer is now a success criterion; risk impact raised to High; noted that awaiting exit is new plumbing vs. the fire-and-forget precedent.
5. **No sensitive-material rule; permission bypass inherited.** Accepted. New bright-line rejection (credentials, tokens, keys, internal endpoints, connection strings, customer data) for all skill modes. Permission mode is now an explicit decision: the configured command is honoured as the user's choice, with a plain-language pre-launch statement and confirmation.

Non-blocking items also taken: STARTER sentence handling stated; bounded git-log survey + cost notice; deterministic empty-repo rule; real-repo verification is a review-phase gate owned by the builder (scenario 18); partial-write case added (scenario 14).

## Gemini (APPROVE) recommendations

Taken: secrets rule, graceful consult fallback, drafts retained on validation failure, prompt tells the user when to exit the session.
