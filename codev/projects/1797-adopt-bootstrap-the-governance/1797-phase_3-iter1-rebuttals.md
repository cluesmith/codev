# Phase 3, iteration 1: responses

Fix commit: 19396aae6.

## Codex (REQUEST_CHANGES)

**`CODEX_SUBCOMMANDS` omits `mcp-server`.** Accepted and fixed. `codex help mcp-server` on
codex-cli 0.162.1 returns "unrecognized subcommand", so the current release doesn't have it.
Earlier releases did, though, and a configured `codex mcp-server` would otherwise get the
prompt appended. It is now in the list with a comment saying where it came from, and
`codex mcp-server` has a regression test.

## Claude (APPROVE, comments)

1. **Claude/Codex guards were asymmetric.** Accepted. Re-verified against `claude --help`
   (2.1.296). Claude now blocks on any of its subcommands (`CLAUDE_SUBCOMMANDS`, including
   aliases), on `--bg/--background` (the session detaches), and on `-r/--resume` (the
   optional value would swallow the positional prompt), in addition to `-p/--print`. Each
   case is tested.
2. **Headless rules were keyed by name.** Accepted. They now live on the providers as an
   optional `interactiveLaunchBlocker?(flags)` that sits next to `buildInteractiveTaskLaunch`.
   `resolveInteractiveTaskLauncher` asks the provider instead of branching on names.
3. **Substring detection.** No change. These are the same semantics already used for role
   injection, and an explicit `architectHarness` remains the precise override.
4. **The `cloud-config.test.ts` umask fix is outside this phase.** Agreed. It is a separate
   commit from phase_1 that the architect approved. The review doc will list it as a side
   fix.

## Gemini (APPROVE)

No action needed.

Harness tests: 83 passed. `tsc --noEmit` is clean.
