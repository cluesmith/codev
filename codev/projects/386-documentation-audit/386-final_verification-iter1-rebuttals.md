# Phase 4 (final_verification) — Iteration 1 Rebuttals

## Codex: REQUEST_CHANGES

### `.builder-role.md` stale af spawn -p references
**Status: NOT APPLICABLE**
`.builder-role.md` is an auto-generated file in the builder worktree (untracked, not committed). It was generated at spawn time from the skeleton `roles/builder.md` which was already fixed in Phase 3. Not a source file.

### INSTALL.md stale references not listed as exception
**Status: ACKNOWLEDGED**
Updated the verification report to explicitly list deprecated files (INSTALL.md, MIGRATION-1.0.md) as allowed exceptions.

### Release notes coverage claim
**Status: FIXED — wording clarified**
Changed from "every tagged release" to "every major/minor release" — many patch tags (v1.4.1, v1.5.5–v1.5.28, v1.6.1–v1.6.2, v2.0.0-rc.*) are iterative patches without dedicated release notes. This is a pre-existing gap, not a regression from this audit.

### Change manifest missing Phase 4 report
**Status: ACKNOWLEDGED**
The verification report is a Phase 4 deliverable; it can't list itself in the manifest. Added a note to clarify.

## Claude: REQUEST_CHANGES

### `codev/roles/architect.md` and `codev/roles/builder.md` still use `af spawn -p`
**Status: FIXED**
Updated all instances in both files to use positional syntax. Also fixed `projectlist.md` → GitHub Issues and `tmux send-keys` → `terminal send-keys` in architect.md.

### `protocols/maintain/protocol.md` tmux/ttyd example
**Status: DEFERRED — OUT OF SCOPE**
The spec explicitly excludes "Protocol .md files (spir/protocol.md, tick/protocol.md, etc.) — these are operational and maintained separately." The maintain protocol example uses tmux/ttyd as an illustration, and while updating it would be good practice, it's outside the audit scope.

### Release notes wording
**Status: FIXED** — see Codex rebuttal above.

## Gemini: REQUEST_CHANGES

### SPIDER → SPIR in MANIFESTO.md and README.md
**Status: FIXED (MANIFESTO.md)**
Updated SPIDER → SPIR in MANIFESTO.md lines 34 and 38.
README.md: No SPIDER reference found (Gemini may have been mistaken — grep confirms zero hits).

### `assert_spider_protocol()` in arch.md
**Status: FIXED**
Updated to `assert_spir_protocol()` — the function no longer exists in the codebase under either name, so the corrected name matches the protocol directory.

### `codev/roles/` af spawn -p references
**Status: FIXED** — see Claude rebuttal above.

### INSTALL.md ansari-project clone URL
**Status: DEFERRED**
INSTALL.md is marked deprecated with a banner at the top. The clone URL accurately reflects where the repo lived at the time the document was current. Updating deprecated files beyond adding the banner is out of scope — the deprecation notice directs users to current installation instructions.
