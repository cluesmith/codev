# Builder thread — bugfix-1128 (consult: codex XProtect/Gatekeeper kill)

## Investigate phase (2026-07-06)

**Reproduced.** `consult -m codex --prompt "..."` fails with raw
`spawn .../node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT`
(exit 1, no explanation). The vendor binary under the global `@cluesmith/codev`
install is gone — XProtect trashed it, exactly as the issue describes. The
`vendor/aarch64-apple-darwin/codex/` directory exists but is empty.

**Root cause confirmed**, with one major new finding that changes the fix shape:

- `@cluesmith/codev` depends on `@openai/codex-sdk ^0.130.0`, which pins
  `@openai/codex 0.130.0` exactly. That version's darwin-arm64 vendor binary is
  unsigned → XProtect (macOS 26) SIGKILLs it and auto-trashes it.
- **`@openai/codex 0.142.5` ships a Developer ID-signed binary.** Verified on this
  machine with `codesign -dvv`: `Authority=Developer ID Application: OpenAI OpCo, LLC
  (2DC432GLL2)`, hardened runtime flag set, `codesign --verify --strict` passes.
  Upstream fixed the root cause between 0.130.0 and 0.142.5.
- Latest stable `@openai/codex-sdk` is `0.142.5`, pinning `@openai/codex 0.142.5`.
- SDK 0.142.5 API surface verified compatible with our `runCodexConsultation`
  usage (Codex config object, startThread options, event types, usage fields —
  checked against the published .d.ts).

**Revised fix plan** (differs from the issue's "primary fix (a)" recommendation,
based on the signing evidence):

1. **(b) becomes the primary fix**: bump `@openai/codex-sdk` → `^0.142.5`. The
   signed binary is the actual root-cause fix for both the npm-install and
   local-install paths. npm tarball extraction preserves the embedded Mach-O
   signature; nothing to "restore" post-install.
2. **(a) is dropped**: ad-hoc codesigning (`--remove-signature` + `--sign -`)
   over a valid Developer ID signature would *downgrade* it — actively harmful
   now that upstream signs. No conditional variant needed either.
3. **(c) stays as the safety net**: detect the two Gatekeeper symptoms in
   `runCodexConsultation` — spawn `ENOENT` on the codex vendor path, and
   `Codex Exec exited with signal SIGKILL` — and emit a legible error naming
   macOS Gatekeeper/XProtect, pointing at issue #1128 and the reinstall fix.

Error surfaces confirmed from SDK source: spawn failure rethrows the raw Node
error (`code === 'ENOENT'`); a killed process throws
`Codex Exec exited with signal SIGKILL: <stderr>`.

Scope: well under 300 LOC (dep bump + lockfile, ~30 lines of detection in
consult/index.ts, regression tests). Proceeding to fix phase; architect notified
of the deviation from the issue's recommendation.

## Fix phase (2026-07-06)

Architect responded: **ship only (b), the SDK bump.**

- (a) codesign fixup: deferred, not killed. If Apple revokes a future 0.142.x
  hash (the 0.130.0 revocation was per-hash, not per team ID), (a) may return
  as a conditional fixup (apply only when spctl reports revocation). Architect
  will re-scope on #1128 after this PR lands.
- (c) legible Gatekeeper error in consult: out of scope for this bugfix; stays
  as an open recommendation on #1128 for a follow-on PR.

Change: `packages/codev/package.json` `@openai/codex-sdk` `^0.130.0` → `^0.142.5`
(caret on 0.x only spans the same minor, so the old range could never pick up
the signed binary on its own) + `pnpm-lock.yaml` refresh.

No regression test added: this is a pure dependency bump with no code change.
The failure mode (XProtect trashing an unsigned vendor binary) is environmental
(macOS + XProtect definitions + signing state of a third-party binary), not
reachable from unit tests. Verification is manual: codesign/spctl on the
resolved vendor binary + launching it, recorded in the PR body.
