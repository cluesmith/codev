# PIR Review: Support Kimi Code CLI as a builder

Fixes #1201

> **Rewritten 2026-09-08 under #1620.** This document described the **retired** seed-session
> design — a `kimi -p` bootstrap, a captured session id pinning `kimi -S <id>`, a sentinel-gated
> store-verified `BEGIN` kick written straight to the PTY, `seed-kick.ts`, `message-pacing.ts`,
> `.builder-seed.txt`. None of that is in the branch; the 2026-08-09 design pivot replaced it once
> kimi 0.31.0's `--agent-file` and Spec 1313's mailbox gave role and task sanctioned homes. The
> plan was rewritten for the same reason. A review artifact that describes code which does not
> exist is worse than no artifact — it is a confident wrong answer for whoever reads it next — so
> it now describes what shipped, including the #1620 amendments made by maintainers on top of
> @mohidmakhdoomi's work.

## Summary

Adds the Kimi Code CLI (`kimi`, **≥ 0.33.0**) as a supported **builder** harness. `shell.builder:
"kimi"` / `builderHarness: "kimi"` / `--builder-cmd kimi` now produce a working builder instead of
the #1062 false-Claude fallthrough, which appended `--append-system-prompt` and a positional
prompt — both rejected by kimi — and could route a stale Claude `--resume <uuid>` into it.

Kimi differs from every previously supported harness in three ways the generic launch shapes cannot
express: **no positional prompt**, **server-side session ids minted on the first message**, and a
**startup folder-trust dialog** that renders before any composer. So the launch shape is
provider-owned (`HarnessProvider.buildBuilderLaunchScript`), and role and task travel separately:

- **Role** → `--agent-file`, an agent-definition file written into the worktree and composed around
  kimi's `${base_prompt}` token so it *extends* rather than replaces kimi's own system prompt.
- **Task** → an ordinary first message queued on the Spec 1313 **mailbox** and delivered by the
  render gate onto a verified-empty composer. Never a direct PTY write, which the mailbox contract
  forbids — so a busy line, a boot screen, or the trust dialog **holds** the message rather than
  corrupting or losing it.

Crash restart resumes with the documented, cwd-scoped **`kimi -c`**, guarded by a store probe that
fails closed (`kimi -c` with nothing to continue does not fail — it starts a fresh session that
never saw `--agent-file`, i.e. a silently roleless builder). Kimi as an *architect* is out of scope
and fails loudly.

## Files Changed

- `packages/codev/src/agent-farm/utils/harness.ts` — `KIMI_HARNESS`, detection,
  `buildBuilderLaunchScript` / `prepareWorkspace` / `messagePacing` capabilities, the agent-file
  composer, the inlined resume probe, and `launchLoopTail` relocated here (exported) so the
  provider-owned script can share it
- `packages/codev/src/agent-farm/utils/kimi-session-discovery.ts` (new) — store scan, ownership
  verification, state reader, the trust record and its refusals, and both drift probes; all
  fail-soft and `KIMI_CODE_HOME`-aware
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — provider-owned script branch in both
  entry points; resolves and passes the trust opt-in
- `packages/codev/src/agent-farm/servers/gate-profiles.ts` — `KIMI_PROFILE` and registry entry
- `packages/codev/src/agent-farm/servers/render-gate.ts` — `regionStartPatterns`, `growsWithDraft`,
  `markerSpanEnd` / `markerSpanStart`, `findRegionStart`, the per-row marker exemption, and the two
  new verdict details
- `packages/sdk/src/hold-verdict.ts`, `db/types.ts`, `db/schema.ts` — both new details in the
  shared predicate, the persisted union, and the column comment
- `packages/codev/src/agent-farm/servers/message-write.ts` — `MessagePacing`, threaded through
  `writeMessageToSession` and `submitMessagePaced`, overriding **both** Enter delays
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` — `resolveHarnessForSession`,
  `resolvePacingForSession`, and pacing at the `writeMessage` binding (which covers cron delivery,
  since it writes through the same port)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — pacing on the `--interrupt` write;
  `--escape` deliberately unpaced, with the reason recorded
- `packages/codev/src/agent-farm/types.ts`, `packages/codev/src/lib/config.ts` — the
  `harnessOptions` namespace, typed and validated at load
- `packages/codev/src/commands/doctor.ts` — kimi presence, the 0.33.0 floor, an auth heuristic, the
  store and trust drift probes, and the architect-use warning
- Tests across `harness.test.ts`, `render-gate.test.ts`, `spawn-worktree.test.ts`,
  `kimi-session-discovery.test.ts`, `mailbox-pacing.test.ts`, `config.test.ts`,
  `bugfix-584-send-multiline-pacing.test.ts`, `hold-verdict-exhaustive.test.ts`, plus eight real
  `fixtures/gate/kimi-*.txt` captures
- Docs: `codev/resources/arch.md`, and `codev/resources/commands/agent-farm.md` mirrored into
  `codev-skeleton/`
- `codev/spikes/pir-1201-kimi-*.mjs` — the measurement spikes and the runnable live-demo driver

## Test Results

- `pnpm build`: clean.
- `pnpm test`: **5,940 passed, 48 skipped, 0 failed** (as of the #1620 merge into converged `main`).
- **#929-class regression covered from four angles**: `kimi` plus a stale Claude `.jsonl` can never
  yield `--resume <claude-uuid>` or `--append-system-prompt` — harness `buildResume`,
  `discoverResumeSession`, config/override resolution, and generated-script assertions.
- The generated resume probe is pinned by a test that **executes** it against fixture stores and
  asserts its printed id equals `findLatestKimiSessionId`'s, so the hand-written snippet cannot
  drift from the TypeScript it mirrors.
- Every generated launch-script shape is parsed by a real `bash -n` — generated shell is the one
  artifact here no type checker reads.

**Live validation status.** The original 7/7 demo ran against real kimi **0.27.0/0.34.0** in
2026-07/08. It has **not** been re-run since: the #1620 maintainer lane has no authenticated Kimi,
and re-measurement plus the now-nine-scenario demo are handed back to @mohidmakhdoomi (checklist on
PR #1203). Latest kimi is **0.41.0**. Treat every measured claim below as carrying its version.

## Architecture Updates

Routed to the **COLD** tier (`codev/resources/arch.md`), a dedicated "Kimi Builder Harness"
subsection under Agent Farm Internals: builder-only status, `--agent-file` role injection, mailbox
task delivery, the guarded `kimi -c` resume and its sticky-fresh identity check, per-harness Enter
pacing across both Enter sites, the render-gate profile including `growsWithDraft` /
`multi-row-draft` and the escalation decision, the gated workspace-trust record, the 0.33.0 floor,
and the undocumented-surface audit with its two drift probes.

No **HOT** tier change: kimi support is subsystem detail, not a top-10 always-on system-shape fact.

## Lessons Learned Updates

Routed to the **COLD** tier (`codev/resources/lessons-learned.md`):

1. *Advisory decorators on critical paths must be failure-total* — a narrow `try`/`catch` in the
   pacing resolver let a mocked-out dependency 500 every `/api/send`. The whole body now degrades
   to defaults.
2. *Prefer a self-describing artifact the launcher already generates over a marker file every
   launch shape must remember to write* — the `.builder-kimi` marker was missed by one shape and
   cost a review cycle; pacing now reads the harness out of the generated `.builder-start.sh`.

## Things to Look At During PR Review

- **The trust pre-write is gated** (#1620): opt-in via `harnessOptions.kimi.autoTrustWorkspace`
  (default false), and refused outright for any worktree shipping `.mcp.json` or
  `.kimi-code/mcp.json`. The earlier "grants strictly less than `--yolo`" argument holds for tool
  execution and not for what trust actually controls — loading folder-defined MCP servers.
- **`multi-row-draft` escalates** (#1620), reversing this branch's original classification. It is
  the one verdict reached when the classifier could not count cells and inferred from box geometry.
- **The `growsWithDraft` premise is load-bearing and version-pinned.** If a post-reply steady-state
  composer ever grows past one interior row, the rule holds every later message forever. Measured on
  0.34.0; re-verification is the contributor's checklist step 2.
- **Undocumented-surface reliance is deliberately narrow** — discovery scans only
  `sessions/*/*/state.json`, and both it and the trust-record naming carry `codev doctor` drift
  probes that weigh records by recency, so a store migration surfaces instead of hiding.
- **`kimiTuiCmd` appends `--yolo`** unless the user already passed it; `--auto` is deliberately never
  used (documented conflict, and it suppresses the agent→user questions the gate workflow needs).
- **Kimi builders have NO write-guard** (#1018 class). kimi *does* document blocking `PreToolUse`
  hooks since 0.32.0, so parity is achievable follow-up rather than a permanent limitation — but it
  is not in place today.
