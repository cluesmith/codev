# PIR Plan: Support Kimi Code CLI as a builder

**Issue**: cluesmith/codev#1201 · **PR**: cluesmith/codev#1203
**Re-planned**: 2026-09-04 under #1620, against `main` after 1,606 commits of convergence.

> **Why this file was rewritten.** The originally-approved plan described a **seed-session bootstrap**: a `kimi -p "<role + task>" --output-format stream-json` one-shot whose captured session id pinned a `kimi -S <id> --yolo` TUI loop, with a sentinel-gated, store-verified `BEGIN` kick written straight to the PTY, plus a `message-pacing.ts` module and a `.builder-kimi-session` marker file. **None of that is in the branch.** It was retired by the 2026-08-09 design pivot (PR #1203 comment thread) once kimi 0.31.0's `--agent-file` and Spec 1313's mailbox made both halves — role and task — expressible through sanctioned seams. Approving the old text would approve a design the code does not implement, so this document now describes the shipped architecture, amended by the #1620 security decisions. Deleted outright: `seed-kick.ts`, `.builder-seed.txt`, the ack-and-wait discipline, the `lastPrompt` dependency (which kimi 0.33.0 broke anyway), `message-pacing.ts`, and the `.builder-kimi` marker.

**Scope fence** (unchanged): the builder-MVI checklist in #1201. Kimi as an **architect** is out of scope and fails loudly. No ACP / `kimi server` adapter. No changes to `tower-utils` / `tower-instances` / `tower-terminals` / `session-manager` / `architect.ts`.

**Evidence rule**: documented claims cite Kimi's CLI reference. The session store layout (`sessions/<ws>/session_<uuid>/state.json`) and the workspace-trust record naming (`workspace-trust/wd_<slug>_<sha256(root)[:12]>`) are **undocumented, observed** surfaces — pinned behind a version floor and two `codev doctor` drift probes that fail loudly when either scheme moves.

---

## Understanding

Configuring `shell.builder: "kimi"` (or `builderHarness: "kimi"`, or `--builder-cmd kimi`) produced a broken builder:

1. `detectHarnessFromCommand('kimi')` did not recognise `kimi`, so `resolveHarness` fell through to `CLAUDE_HARNESS` — the #1062 false-Claude fallthrough.
2. The false Claude harness generated a script appending `--append-system-prompt "$(cat role)"` **and** a positional prompt. Kimi rejects both, so the `while true` loop restarted into the same failure forever.
3. It also exposed Claude's `buildResume`, so a stale Claude `.jsonl` for the worktree path could route `--resume <claude-uuid>` into `kimi` — the pre-#929 crash-loop class.

Kimi's CLI differs from every harness Codev supported before in three ways that the generic launch shapes cannot express:

- **No positional prompt.** The task cannot ride argv the way Claude's does.
- **Server-side session ids, minted on the first message.** There is no id to pin at launch, so `session.newSessionScriptFragment` (#1233) has nothing to mint.
- **A startup folder-trust dialog** (0.33.0+) that renders *before* any composer and whose only non-trusting option exits kimi.

## Proposed Change

### 1. Harness identity — `utils/harness.ts`

`detectHarnessFromCommand` recognises a `kimi` basename, which alone kills the #1062 fallthrough. `KIMI_HARNESS: HarnessProvider`:

- **`buildRoleInjection` throws.** Kimi is builder-only; the message names the reason (kimi's role mechanism is `--agent-file <path>`, which needs a file written into the agent's directory — a seam only the builder launch path has) and points at claude/codex for the architect. The OpenCode precedent.
- **`buildScriptRoleInjection`** returns `--agent-file '<worktree>/.builder-role-agent.md'`.
- **`getWorktreeFiles`** writes that agent-definition file — YAML frontmatter plus a body opening with `${base_prompt}`. That token is load-bearing: it interpolates kimi's own default system prompt so the role **extends** rather than replaces it (the `--append-system-prompt` analogue). A roleless spawn writes nothing.
- **`messagePacing: { enterDelayMs: 1000 }`.** Kimi's paste-detection window swallows an Enter arriving too soon after the body. Bisected live: 80/100 ms fail, 120/250/500/1000 ms submit. Pinned at 1000 ms for ~9× margin; the only cost is submission latency, which is irrelevant agent-to-agent.
- **`prepareWorkspace`** — the trust record, item 4.
- **`buildBuilderLaunchScript`** — item 2.
- **`buildResume`** answers one question (does a conversation exist for exactly this worktree?) and the *answer*, not the id, is what the script uses: it returns `args: ['-c']` / `scriptFragment: '-c'`, so no undocumented id is ever baked into generated bash. The id rides the return value only because callers log it and a `null` means "nothing to resume".
- **No `session` block.** The stored-UUID contract requires minting an id at spawn, which Kimi cannot do.

`launchLoopTail` moves from `spawn-worktree.ts` into `harness.ts` (exported, unchanged byte for byte) so the provider-owned script can share it. `spawn-worktree.ts` already imports from `harness.ts`, so this is the acyclic direction.

### 2. Provider-owned launch script

`startBuilderSession` and `buildWorktreeLaunchScript` branch to `harness.buildBuilderLaunchScript` when present; every existing harness keeps the generic shapes untouched. Three generated shapes:

**Bare** (`afx spawn --worktree`, or no role and no task) — the plain loop, byte for byte what any session-less harness gets. A roleless kimi launch *is* fresh, so a clean exit relaunches fresh.

**Task-carrying** — the interesting one:

- **Task delivery rides the mailbox.** The script calls `afx send <builderId> "$(cat .builder-prompt.txt)"` on each *fresh* launch. It is never a direct PTY write, which Spec 1313 forbids for message writers — so a busy line, a boot screen, or the folder-trust dialog simply **holds** the message instead of corrupting or losing it. It lives inside the fresh path because only the script knows when a new conversation starts, mirroring claude's prompt-on-fresh semantics.
- **`codev_task_queued` guards the crash loop.** Set once the row is on the mailbox, so a builder failing to start cannot re-enqueue the same mission every two seconds (the mailbox *persists* a held row; it does not need re-queueing to survive). Reset only on the human-gated clean-exit relaunch, which is a deliberate new conversation and does want its task again. **Accepted tradeoff in the other direction:** the reset assumes the first row was delivered, which is the common case but not a guarantee — quit at a screen that never rendered a composer and the reset queues a second identical row. One mission, stated twice, recoverable by reading; the alternative (de-duplication) needs either a delivery receipt the script cannot see or a mailbox-side identity check.
- **Every interpolated value enters the script exactly once**, inside a single-quoted assignment escaped by `shellEscapeSingleQuote`, never inside executable double-quoted text. Recovery hints print through `printf '%s\n'` with the shell *variable* expanded, because bash does not re-scan an expansion for command substitution — so a builder id or task path containing a backtick or `$(…)` is printed literally rather than executed.
- **`afx` missing from PATH, or Tower down**, prints a warning with the exact recovery command and continues. Queueing is best-effort; it never aborts a launch.

**Crash resume is guarded `kimi -c`** (documented, cwd-scoped) rather than an undocumented id:

- `kimi -c` with nothing to continue **does not fail** — it starts a fresh session that never saw `--agent-file`, i.e. a silently **roleless** builder. So the loop only takes `-c` once an inlined node probe proves a session exists for this cwd. The probe is checked on **both** stdout and exit status: stdout alone would accept anything written by a `node` wrapper on PATH or a `NODE_OPTIONS=--require` preload.
- The probe compares session **identity**, not existence, to honour #1267's sticky-fresh contract. Because `-c` is cwd-scoped, existence alone leaves a real gap: a clean exit relaunches fresh, 0.33.0+ mints no session until the first message lands, and a crash inside that pre-mint window would find the just-abandoned conversation still newest and continue *it* — resurrecting exactly what the user walked away from. The loop records the superseded id at clean exit and refuses `-c` until the newest id differs.
- The probe **mirrors `findLatestKimiSessionId` field for field** — per-field `typeof` on `cwd` then `workDir` (not `cwd ?? workDir`, which short-circuits on a non-string `cwd`), realpath tolerance, archived/`session_` filters, and timestamp ranking — because a divergence is a silent bug in either direction. A unit test **executes** the generated snippet against fixture stores and asserts its answer equals discovery's, so the mirroring cannot rot.
- **Fails closed**: any error prints nothing and routes the loop to the fresh, role-carrying launch. Two edges are traced and accepted (the superseded id lives in loop memory, so it does not survive terminal re-creation; a GC that drops the *newest* session while keeping older ones would let `-c` continue an older conversation).

### 3. Render-gate composer profile — `servers/gate-profiles.ts`, `servers/render-gate.ts`

Under Spec 1313, delivery only happens for a **measured** harness; an unknown one holds every message with `no-profile`. So a Kimi profile is a functional prerequisite, not polish. Kimi breaks two assumptions the existing profiles share:

- **Its marker is not at the row start.** Kimi draws a rounded box, so the input row is `│ > `, marker at column 3. `KIMI_MARKER = /^\s*│\s*>/`, and the classifier's chrome exemption becomes "skip the exact span the marker pattern matched" (`markerSpanEnd`) rather than "skip column 0" — a no-op for claude/codex/agy, whose matches start at 0. A guardrail test pins the exact span each shipped profile yields, because that number is the whole basis of the no-op claim.
- **Its composer spans more than the marker row.** `regionStartPatterns` (`/^\s*╭[─━╌┄]{3,}/`) gives the region a proven **upper** bound; without one, last-match-wins moves the region *below* real draft text and a composer holding a draft classifies `clean`. The bound is exclusive, because the box top's `╮` corner is not in the ignore set. A profile that declares a region start but has none on screen yields the new detail `no-region-start` and holds — the mirror of `no-region-end`.

`KIMI_REGION_END = [/^\s*╰[─━╌┄]{3,}/]`, because the shared rule patterns require the line to *start* with the rule glyph and kimi's starts with a space.

**`growsWithDraft`** is a separate opt-in that arms the `multi-row-draft` rule: one draft shape has *zero* countable cells (type a newline then `>`, and every cell is whitespace, box chrome, or an exempted marker), so shape is the only evidence left. It is sound only because box growth is **exclusive to multi-line drafts**, measured rather than assumed — idle, single-line draft, `/` menu, `@` picker, mid-generation at 5 s and 13 s, shift+tab mode chrome, a draft typed while working, and the post-reply steady state **all** hold at one interior row. The steady state is the load-bearing measurement: growth on a composer that has already carried a turn would hold every later message forever, a liveness bug rather than a fail-safe one. It is deliberately kept separate from `regionStartPatterns` because the shipped `codex-idle.clean.txt` capture is a genuinely *empty* composer spanning two interior rows — fold the two together and the day anyone declares a region start for codex, codex mail stops delivering silently.

The profile deliberately sets **no** `markerFgPalette` and **no** `placeholderFgPalette`: an idle Kimi composer carries no placeholder text at all, and the palette anchor is not needed once the region is bounded. Two consequences verified against real captures: the trust dialog has no marker → `no-composer-marker` → held, so a blind Enter can never confirm filesystem trust; and `!` bash mode replaces the `>` glyph → also held, correctly, because there is unsent input on that row.

**Both new details escalate.** `no-region-start` and `multi-row-draft` are added to `MailboxGateDetail`, to the schema column comment, and to `isUnverifiableVerdict` in `packages/sdk/src/hold-verdict.ts` — the single definition of "will this hold clear on its own?", which `mailbox-delivery.ts`'s `isClassifierStuck` delegates to. There is deliberately **no** second copy of that rule: an escalation policy and an operator-facing remedy that disagree about the same row is the failure mode the sharing exists to prevent. A test enumerates `GateVerdict['detail']` and asserts every value is classified, so the union cannot grow silently.

### 4. Workspace trust — `utils/kimi-session-discovery.ts` *(amended by #1620)*

kimi 0.33.0 opens on a "Trust this folder?" dialog, and a builder worktree is always a brand-new directory. There is no flag, env var, or config key to suppress it, so an unattended builder would sit there forever. Codev can pre-record trust in kimi's own store (`workspace-trust/wd_<basename lowercased>_<sha256(root)[:12]>`, derived by observation and verified end-to-end).

Trust gates exactly one thing: whether **project-level MCP servers** (`.mcp.json`, `.kimi-code/mcp.json`) load from the folder. It does not gate tool execution or writes. That is a narrow grant — but it is still a capability grant made on the user's behalf, so `ensureKimiWorkspaceTrust` refuses in two independent cases and returns a structured `KimiTrustDecision` so callers can log *which*:

- **`not-opted-in`** — the default. The pre-write happens only when `.codev/config.json` sets `harnessOptions.kimi.autoTrustWorkspace: true`.
- **`project-mcp-config`** — the worktree contains `.mcp.json` or `.kimi-code/mcp.json`. This is the one case where the trust decision is genuinely load-bearing, so it is the one case a human must make, opt-in or not.

On either refusal the dialog appears, the render gate holds the task message with `no-composer-marker` (in the escalation class, so it surfaces rather than hanging silently), and the log names the reason. Also `already-trusted` (idempotent — an existing record is left alone) and `write-failed` (fail-soft: a failure degrades to the CLI's normal behaviour, never aborts a spawn).

**Consequence, documented rather than footnoted:** a repository shipping a root `.mcp.json` hits the second refusal on *every* Kimi builder worktree, so unattended Kimi spawning does not work there until a human trusts the folder once.

`HarnessProvider.prepareWorkspace` takes `(worktreePath, { autoTrustWorkspace })`; both call sites resolve the flag from config. `harnessOptions` is a **new** config namespace, separately typed and validated — deliberately not `harness.kimi`, because `harness.*` is the custom-harness-definition namespace whose load-time validator hard-requires `roleArgs`/`roleScriptFragment` (a settings-shaped entry there would throw at config load and break unrelated commands), and because built-ins already win resolution, making `harness.kimi` dead config.

### 5. Version floor and drift probes — `commands/doctor.ts`

Floor **0.33.0**, evidence-based rather than conservative-by-default: 0.33.0 made the agent-core-v2 engine the default, renamed `state.json`'s `workDir` → `cwd`, prefixed session ids `session_<uuid>`, stopped minting a session at TUI startup, and added the trust dialog. Everything below it is an engine this integration never measured. **Never lowered.**

`codev doctor` reports kimi presence, the version gate, an auth heuristic, and two drift probes that exist because the surfaces they watch are undocumented:

- **Store layout** — session ids still `session_<uuid>`, `state.json` still carries a working-directory field. Both probes use the same conservative recency tie-break: drift is reported only when the newest *disagreeing* record is strictly newer than every agreeing one, because after a scheme change the old records keep agreeing forever.
- **Trust-record naming** — recompute the expected filename from the `root` each of kimi's own records carries and compare. If the scheme moves, the pre-write lands where kimi no longer reads, the dialog reappears, and nothing else in the codebase would notice: the write still "succeeds".

Configuring kimi as the **architect** warns, matching the opencode/gemini precedent.

### 6. Per-harness Enter pacing on the delivery path

`MessagePacing { enterDelayMs? }` overrides message-write's default Enter delay for both the simple and the paced branches; all other timing is unchanged, and the override only moves the Enter *later*, so `submitMessagePaced`'s promise still resolves after the Enter is on the wire. Resolution keys off the harness recovered from the generated `.builder-start.sh` — the same self-describing signal the gate resolves, and override-proof by construction because the script is *generated from* the resolved harness, so `--builder-cmd kimi` against a claude-configured workspace still reads `kimi`. (This replaced an earlier `.builder-kimi` marker file, whose every launch shape had to remember to write it — an obligation one shape missed.)

Resolution is **advisory and total**: unreadable worktree, unknown or retired harness, custom harness — every failure path degrades to the defaults rather than throwing into the delivery path. An earlier iteration 500'd `/api/send` by not being total; that lesson is load-bearing here.

Applied at the mailbox `writeMessage` binding (which covers cron delivery too, since it writes through the same port) and on the `--interrupt` path, which writes body-then-Enter exactly like a gated delivery. **Not** applied to `--escape`, which writes no text: Kimi's swallowed-Enter behaviour is paste detection keyed to a preceding text burst, and pacing it either way is unmeasured, so it stays at the Spec 1273 timing rather than changing on a guess.

### 7. Out of scope, fenced

Kimi as architect (stage 2). ACP / `kimi server`. `PreToolUse` write-guard parity for Kimi builders (#1018 class — kimi *does* now document blocking hooks, so this is a real follow-up, not an impossibility; the stale "no hook seam" claim is corrected in the docs). A `codev doctor` premise probe for the box-growth assumption. Echo-verification tolerance beyond measurement (#1578).

---

## Files to Change

- `packages/codev/src/agent-farm/utils/harness.ts` — `KIMI_HARNESS`, detection, `BuilderLaunchScriptContext`, `buildBuilderLaunchScript` / `prepareWorkspace` / `messagePacing` capabilities, `buildKimiAgentFile`, the resume probe, relocated `launchLoopTail`
- `packages/codev/src/agent-farm/utils/kimi-session-discovery.ts` — store scan, ownership verify, state reader, trust record + refusals, both drift probes (all fail-soft, `KIMI_CODE_HOME`-aware)
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — provider-owned script branch in both entry points; resolve and pass `autoTrustWorkspace`
- `packages/codev/src/agent-farm/servers/gate-profiles.ts` — `KIMI_PROFILE` + registry
- `packages/codev/src/agent-farm/servers/render-gate.ts` — `regionStartPatterns`, `growsWithDraft`, `markerSpanEnd`, `findRegionStart`, per-row marker exemption, the two new details
- `packages/sdk/src/hold-verdict.ts` — `isUnverifiableVerdict` classifies both new details
- `packages/codev/src/agent-farm/db/types.ts`, `db/schema.ts` — `MailboxGateDetail` union + column comment
- `packages/codev/src/agent-farm/servers/message-write.ts` — `MessagePacing`, threaded through `writeMessageToSession` and `submitMessagePaced`
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` — `resolveHarnessForSession`, `resolvePacingForSession`, pacing at the `writeMessage` binding
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` — no local stuck-verdict fork; `isClassifierStuck` delegates
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — pacing on `--interrupt`; `--escape` deliberately unpaced
- `packages/codev/src/agent-farm/types.ts`, `packages/codev/src/lib/config.ts` — `harnessOptions`, typed and validated at load
- `packages/codev/src/commands/doctor.ts` — presence, 0.33.0 floor, auth heuristic, both drift probes, architect warning
- Tests: `kimi-session-discovery.test.ts`, `mailbox-pacing.test.ts` (new); `harness.test.ts`, `render-gate.test.ts`, `spawn-worktree.test.ts`, `config.test.ts`, `bugfix-584-send-multiline-pacing.test.ts`, `tower-routes.test.ts` (extended); `__tests__/fixtures/gate/kimi-*.txt` (eight captures + README)
- Docs: `codev/resources/arch.md` (Kimi subsection), `codev/resources/commands/agent-farm.md` + `codev-skeleton/` mirror
- `codev/spikes/pir-1201-kimi-*.mjs` — the measurement spikes and the runnable live-demo driver

## Risks & Alternatives Considered

- **Risk — undocumented surfaces (store layout, trust-record naming) move under us.** Two doctor drift probes with a conservative recency tie-break, a version floor, and fail-closed readers everywhere. Direction of failure is always "fall back to a fresh, role-carrying launch" or "hold the message", never "deliver onto a screen we failed to understand".
- **Risk — the box-growth premise drifts and `multi-row-draft` becomes permanent.** It escalates (item 3), and a doctor premise probe is filed as a follow-up.
- **Risk — Kimi ships weekly and re-drifts.** Realised once already (0.27.0 → 0.34.0 → 0.41.0). Mitigated by the probes, not by pinning.
- **Alternative rejected — the seed-session bootstrap** (the original plan). Necessary when 0.27.0 had no role flag and no way to deliver a task; obsolete once `--agent-file` and the mailbox existed. It also required a direct PTY write, which Spec 1313 forbids.
- **Alternative rejected — pin the resumable session by id instead of `kimi -c`.** Would bake an undocumented id into generated bash, and kimi mints ids server-side on the first message, so there is nothing to pin at launch.
- **Alternative rejected — trust pre-write default-on with an opt-out.** Preserves unattended spawning out of the box, and silently grants a capability the user never chose. Default-off is the only direction whose failure mode is an inconvenience rather than a security event.
- **Alternative rejected — a `.builder-kimi` marker for pacing resolution.** Obliged every launch shape to remember to write it; one shape missed, and it cost a maintainer review cycle.

## Test Plan

**Unit** — `harness.test.ts` (all three generated script shapes: task queueing before the loop, the `-c` guard's both-signals check, the superseded-id comparison, `launchLoopTail` interpolation, architect-use throw, agent-file `${base_prompt}` composition); `kimi-session-discovery.test.ts` (store scan against fixture stores, per-field `cwd`/`workDir`, realpath tolerance, archived filter, ranking, both drift probes, and the six trust-decision cases); a test that **executes** the generated resume probe and asserts it agrees with `findLatestKimiSessionId`; `render-gate.test.ts` against the eight Kimi fixtures plus the `markerSpanEnd` guardrail for every shipped profile; `mailbox-pacing.test.ts` (pacing resolves from the launch script, is total on every failure path, and reaches the Enter through `submitMessagePaced`); `config.test.ts` (`harnessOptions` parse, default, rejection); the `hold-verdict` exhaustiveness test. The **#929 class** is covered from four angles: `kimi` + a stale Claude `.jsonl` can never yield `--resume <claude-uuid>` or `--append-system-prompt` — harness `buildResume`, `discoverResumeSession`, config/override resolution, and generated-script assertions.

**Build + suites** — `pnpm build` clean; full `pnpm test` green, including the `codev-core` / `codev-sdk` boundary tests (the `hold-verdict.ts` edit touches the SDK).

**Live demo** (against a real authenticated kimi ≥ 0.33.0). Run by @mohidmakhdoomi, not by the #1620 re-plan lane — the human confirmed on 2026-09-05 that no authenticated Kimi is available maintainer-side, so the Kimi-facing evidence comes from the contributor and attaches to PR #1203. `node codev/spikes/pir-1201-kimi-builder-demo.mjs`, nine scenarios: gate classifies the live composer; role honoured via `--agent-file` in the interactive TUI; multi-line delivery submits at the pinned Enter delay; crash restart consults the store probe and chooses resume; role survives the `-c` resume; the probe fails closed on an empty store; trust pre-record is idempotent; **an opted-out spawn writes no record**; **a worktree carrying `.mcp.json` writes no record and logs the refusal.** Plus the full Tower path (`afx spawn --builder-cmd kimi`, `afx send` with a multi-line body, `codev doctor`).

**Measured facts and who measured them.** The render-gate profile, the `growsWithDraft` box-growth premise, the 1000 ms Enter delay, the trust-record naming scheme and the `kimi -c` newest-session semantics were all measured on **kimi 0.34.0** (2026-08). Kimi's behaviour under the #1573/#1584 echo-verification path is **not yet measured on any version**. Both are re-verified by @mohidmakhdoomi before merge; a contradiction returns to the maintainer lane rather than shipping.
