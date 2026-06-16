# PIR #929 — Support codex & gemini CLIs as architects

## Builder thread

### 2026-05-31 — Plan phase

Investigated the resume crash-loop bug. Root cause confirmed across two sites, one mechanism:

- **Architect**: `tower-instances.ts:500` calls `findLatestSessionId(workspacePath)` (reads only `~/.claude/projects/<encoded-cwd>/*.jsonl`) without gating on the configured harness, then builds `[...cmdParts.slice(1), '--resume', resumeSessionId]`. A codex/gemini architect + any stale Claude jsonl ⇒ `codex --resume <claude-uuid>` ⇒ shellper restart-loop to death.
- **Builder**: `spawn.ts:83 discoverResumeSession()` (called at 459 + 838) has the same Claude-only assumption; `spawn-worktree.ts:746` then bakes `${baseCmd} --resume "${id}"` into the launch script. `workspace-recover.ts` re-enters via `afx spawn --resume`, inheriting it.

**Fix direction**: add an optional `discoverResumeSession?` capability to `HarnessProvider`. Only `CLAUDE_HARNESS` implements it (delegates to `findLatestSessionId`); codex/gemini/opencode leave it undefined ⇒ null ⇒ fresh launch via `buildArchitectArgs` / role-injection script path. Gate both call sites on the harness. The downstream `--resume` arg/script construction is reached only when claude returned a non-null id, so it stays claude-shaped safely.

**Scoping decision**: MVP fixes the **config-driven** selection path (`.codev/config.json` `shell.architect`/`architectHarness`), which is what every acceptance criterion is phrased around. The `TOWER_ARCHITECT_CMD`/`--architect-cmd` env/CLI-override-without-matching-config edge stays a documented nice-to-have (issue lists it as such).

**Empirical validation** (launch on stale-jsonl cwd, add-architect, `afx send` multiline/interrupt/streaming, reconnect, affinity, dashboard scrollback) needs codex/gemini actually installed — that happens at the `dev-approval` gate when the human runs the worktree. That's precisely why PIR was chosen.

Architect PR-target note: no push access to cluesmith/codev — push branch to fork `mohidmakhdoomi/codev`, open PR with `gh pr create --repo mohidmakhdoomi/codev`.

Plan written, awaiting `plan-approval`.

### 2026-05-31 — Plan revision (architect feedback, 5 verified issues)

Revised after a 2-way consult + architect verification:
1+2. **Seam redesign**: collapsed the two paired methods (`discoverResumeSession` + `buildResumeInvocation!`) into a single bundled `buildResume?(cwd, opts) → { sessionId, args, scriptFragment } | null`, mirroring `buildRoleInjection`/`buildScriptRoleInjection`. Node-argv `args` for the architect `spawn()` site; **shell-escaped** `scriptFragment` for the builder bash generator. Kills the `!` non-null assertion and the raw-argv `.join(' ')` word-split/quoting bug.
3. **Test layering fix**: regression guards moved to where the bugs live — `tower-instances.test.ts` (architect launch, no `--resume` for codex/gemini + stale jsonl) and `spawn-worktree.test.ts` (builder script uses escaped fragment). `af-architect.test.ts` (no-Tower command only) noted as NOT guarding the real regression.
4. **Gemini context promoted to MVP**: add `getArchitectFiles?` hook; `GEMINI_HARNESS` writes `.gemini/settings.json` `context.fileName → AGENTS.md` (write-if-missing). Codex already reads AGENTS.md natively; gemini shipped context-blind otherwise.
5. **Builder override caveat documented**: `--builder-cmd`/env vs config-only `getBuilderHarness` is the exact analog of the architect `TOWER_ARCHITECT_CMD` trap — added to Risks alongside it.

Re-signalled, awaiting architect re-review.

### 2026-05-31 — Implement phase

Plan approved. Implemented all six tasks:

1. **harness.ts**: added `buildResume?` (bundled discovery + Node-argv + escaped script fragment) and `getArchitectFiles?` to `HarnessProvider`. `CLAUDE_HARNESS.buildResume` delegates to `findLatestSessionId`; `GEMINI_HARNESS.getArchitectFiles` writes `.gemini/settings.json` → AGENTS.md. codex/gemini/opencode leave `buildResume` undefined.
2. **tower-instances.ts**: architect resume now gated on `getArchitectHarness(...).buildResume?.()` (preserving the `safeToResume` sibling guard); writes `getArchitectFiles?()` if-missing on launch.
3. **spawn.ts / spawn-worktree.ts**: `discoverResumeSession` takes the builder harness and returns the bundled object; `startBuilderSession`'s `resumeSessionId?: string` → `resume?: { sessionId, scriptFragment }`, script emits `${baseCmd} ${resume.scriptFragment}`.
4. **doctor.ts / arch.md**: codex/gemini architect affirmation + "resume is Claude-main-only" docs.
5. **Tests**: `discover-resume-session.test.ts` (harness arg + codex/gemini null-return guards), `tower-instances.test.ts` (architect resume-skip for codex/gemini + stale jsonl; claude still resumes; gemini `.gemini/settings.json` write-if-missing + no-clobber), `spawn-worktree.test.ts` (resume script uses escaped fragment, no prompt/role injection; fresh path has no `--resume`).

**Test-infra notes**: worktree had no `node_modules` — ran `pnpm install` + built `@cluesmith/codev-core` (vitest loads source which imports the core package's subpath exports). Two mock gaps surfaced and were fixed in the test files: `tower-instances.test.ts` db mock needed `getDb`/`closeDb` (state.getArchitects uses `getDb()`, not the already-mocked `getGlobalDb` — without it the `safeToResume` guard threw and silently skipped the claude resume); `spawn-worktree.test.ts` needed a `../lib/tower-client.js` mock (getTowerClient stub) so `startBuilderSession`→`createPtySession` runs without a live Tower.

The three affected files: 143 passed. Full suite running. Build green.

### 2026-06-16 — Review phase

dev-approval gate approved (human validated the running worktree). Re-confirmed build green + 146 tests pass across the 3 affected files. Wrote `codev/reviews/929-support-codex-and-gemini-clis-.md` (Summary / Files / Architecture Updates / Lessons Learned / Things to Look At). arch.md was already updated in the implement commit; routed one cold-tier lesson to `lessons-learned.md` (Architecture): audit **all** invocation seams — including resume/restart — when extending a provider abstraction; the resume branch is a separate call site Spec 591 left harness-blind.

PR target: branch lives on fork `mohidmakhdoomi/codev` (origin push → fork; `builder/pir-929` confirmed on fork, absent on cluesmith). Opening PR within the fork (base `main`). Recording with porch, then `porch done` runs the single-pass CMAP-2 verify.
