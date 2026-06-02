# Specification: Migrate the Gemini consult lane to the Antigravity CLI (`agy`)

## Metadata
- **ID**: spec-2026-06-01-778-gemini-antigravity-cli
- **Status**: draft (rewritten to Approach B per architect directive 2026-06-02)
- **Created**: 2026-06-01
- **Issue**: #778
- **Deadline**: 2026-06-18 (Gemini CLI subscription serving retires)

## Architect Directive (supersedes prior draft)
The first draft recommended pivoting the Gemini lane to the Gemini **Developer API** (Approach A).
The architect **rejected** that at the spec-approval gate and directed **Approach B — swap the lane's
backend from the `gemini` CLI to the Antigravity CLI (`agy`)** — with these fixed priorities:
1. **Preserve agentic file-reading.** `agy` is an agent that reads files from disk like the old
   `gemini` CLI. Do **not** inline-and-strip filesystem access (that was an A-path quality
   regression). Keep the existing "read the diff / explore the filesystem" reviewer prompts.
2. **Keep the Pro model** (gemini-3.1-pro-class). Pro ≫ flash for code-review quality; do not let
   reviews default to flash.
3. **Subscription / OAuth auth** (AI Ultra) — ~3× cheaper than per-token API for our volume. **Not**
   an API key.
4. **Keep it lean.** This is fundamentally a backend swap (`cli:'gemini'` → `agy` + flags) + auth +
   the skip safety, **not** a redesign.

The prior draft's two good catches are **retained**: (a) a dead/unavailable lane must be a
**porch-safe NON-BLOCKING skip** (porch's verdict parser defaults missing/short output to
`REQUEST_CHANGES`, which would otherwise block phase progression); (b) usage/cost handling must
**degrade gracefully** (subscription credits aren't per-token). The Gemini-API approach is now
**out of scope** (see Out of Scope).

## Problem Statement
Codev's `consult` tool uses the Google **Gemini CLI** (`gemini`) as one of three default reviewer
lanes (with Codex and Claude). On **June 18, 2026**, the Gemini CLI / Code Assist subscription
serving stops for Google AI Pro/Ultra/free-individual users. Because `gemini` is a *default* model
and porch's verdict parser blocks on a missing/error review, the dead lane would not just reduce
review coverage — it would **block** SPIR/ASPIR/BUGFIX/AIR/PIR/MAINTAIN phase progression for
affected users on a hard deadline. Codev must move the "Gemini perspective" onto Google's
replacement, the **Antigravity CLI (`agy`)**, using the user's subscription auth.

## Verified `agy` Contract (empirical, 2026-06-01)
All of the following was confirmed by installing and running the real CLI on macOS (darwin_arm64):

- **The real CLI is a standalone binary, distinct from the IDE.** `which agy` resolves to
  `~/.antigravity/antigravity/bin/agy`, which is a **symlink to the Antigravity IDE Electron binary**
  (`/Applications/Antigravity.app/.../bin/antigravity`) — *not* the headless CLI. The real CLI is a
  ~142 MB native Go binary, **v1.0.4**, installed via the official Unix script
  `https://antigravity.google/cli/install.sh` (SHA512-verified) to **`~/.local/bin/agy`**. The
  installer prepends `~/.local/bin` to PATH (`.zshrc`/`.zprofile`), so fresh shells resolve the real
  CLI — but Codev must **not trust PATH** (stale shells / the IDE symlink shadow it). → **Footgun:
  Codev must invoke the real CLI deterministically** (pin path and/or verify the resolved binary is
  the CLI, e.g. it answers `--print`, not the IDE launcher).
- **Headless mode:** `agy --print` (aliases `-p`, `--prompt`) — "run a single prompt
  non-interactively and print the response." `--print-timeout <dur>` (default 5m).
- **File access (preserves agentic reading):** `agy --print --sandbox --add-dir <dir> "<prompt>"`
  reads files from `<dir>` non-interactively **without** `--dangerously-skip-permissions` —
  verified end-to-end (the reviewer read a planted file and returned its contents). `--sandbox`
  ("terminal restrictions enabled") auto-grants read access to `--add-dir` paths without a TTY
  prompt. This is the **recommended, more-constrained** mechanism; the broader
  `--dangerously-skip-permissions` (auto-approve *all* tool requests) is **not needed** and was
  (rightly) flagged as a risk — avoid it.
- **Auth = OAuth / subscription** (matches priority #3): first run prints a Google OAuth URL (scopes
  `cloud-platform`, `userinfo.email/profile`, `openid`) and accepts a browser sign-in or a pasted
  auth code; the token then persists (under `~/Library/Application Support/Antigravity`) and
  subsequent `--print` runs need no re-auth. No API key. **Caveat:** the first-run auth wait is short
  (~30s) and **interactive** — it cannot be completed head-less in CI.
- **No `--model` flag, and the DEFAULT is Flash — not Pro.** Per Antigravity docs, the CLI defaults
  to **Gemini 3.5 Flash (High)**; the **Pro** class is selected via the interactive **`/model`**
  slash command (offering e.g. Gemini 3.1 Pro High/Low, 3.5 Flash variants; the `-preview` suffix is
  dropped post-Antigravity-2.0, so the id is now `gemini-3.1-pro`-class). **Consequence:** a naïve
  `agy --print` would silently use **Flash**, violating architect priority #2 — so Pro selection is
  mandatory, not optional. How to make a *non-interactive* `--print` run use Pro (a persisted
  `/model` choice vs. a config file vs. subscription default) is the critical open question (below).
  Binary internals corroborate a model-tier system (`GetModelTier`/`GetPlanModel`/`GetFlashLite`/
  `customModels`). A self-id probe **timed out**, so the model id is not reliably introspectable via
  `--print`.
- **No JSON / usage output.** `--print` returns plain text only — no token-usage stats. → cost rows
  must degrade gracefully.
- **No system-prompt/role flag** (no `GEMINI_SYSTEM_MD` equivalent). → fold the reviewer role into
  the `--print` prompt text.
- **Instruction-following works** in `--print` (a constrained "reply with only X" task returned
  exactly X).

## Current State (Codev's `gemini` surface — audited 2026-06-01)
- `packages/codev/src/commands/consult/index.ts:37-40` — `MODEL_CONFIGS.gemini = { cli:'gemini',
  args:['--model','gemini-3.1-pro-preview'], envVar:'GEMINI_SYSTEM_MD' }`; spawns with
  `--output-format json`, role via `GEMINI_SYSTEM_MD` temp file, prompt via stdin (heap handling for
  >500 KB diffs, bugfix #680), parses JSON usage. Alias `pro → gemini` (`:54-58`).
- Prompt builders rely on **agentic file-reading** (to be PRESERVED): `:884` "Read the diff file from
  `${diffPath}`", `:1051` "Explore the filesystem", `:885/1042/1154/664/1588` "full filesystem
  access". `buildPRQuery` writes the diff to a temp file and points the reviewer at it.
- `packages/codev/src/lib/config.ts:88` — default consult models `['gemini','codex','claude']`.
- `codev-skeleton/protocols/{spir,aspir,maintain}/protocol.json` default `["gemini","codex","claude"]`;
  `{air,pir,bugfix}` default `["gemini","codex"]`. `protocol-schema.json:155` enum includes `gemini`;
  `porch/next.ts:51` `VALID_MODELS` includes `gemini`.
- `packages/codev/src/commands/porch/verdict.ts:27,46-47,55` — missing/short/error verdict → defaults
  to `REQUEST_CHANGES`; `CONSULT_ERROR`/`REQUEST_CHANGES` block approval. (Why the skip must be
  explicitly non-blocking.)
- `packages/codev/src/commands/doctor.ts:153-163` (presence check, hint → gemini-cli github) and
  `:266-274` (auth check `gemini --yolo 'Reply with just OK'`).
- `packages/codev/src/commands/consult/usage-extractor.ts` — pricing key `gemini-3.1-pro`.
- Other surfaces (scoped below): `agent-farm/utils/harness.ts:114,240` (Gemini-CLI *builder*
  harness), `generate-image.ts` (Gemini **API**, unaffected), `bench.ts` (benchmark defaults), docs.
- ~60 tests across `consult.test.ts`, `consult.e2e.test.ts`, `metrics.test.ts`,
  `consultation-models.test.ts`, `doctor.test.ts`, `config.test.ts`.

## Desired State
- The Gemini consult lane invokes **`agy --print --sandbox --add-dir <repoRoot>`** (role folded into
  the prompt), reaching Gemini via the user's **subscription/OAuth** auth, with the reviewer still
  **reading the diff/repo from disk** (agentic behavior preserved).
- The lane uses the **Pro** model class (mechanism per Open Questions).
- Codev invokes the **real `agy` CLI deterministically**, never the IDE symlink.
- A missing/unauthed/timed-out `agy` lane is a **non-blocking skip**: porch-orchestrated runs still
  advance (Codex/Claude complete; Gemini reported skipped — not a blocking `REQUEST_CHANGES`/
  `CONSULT_ERROR`).
- Cost/usage rows **degrade gracefully** (no `NaN`; show e.g. "n/a (subscription)").
- `codev doctor` checks for the real `agy` CLI + auth and gives correct, current setup guidance
  (official install script; one-time `agy` login). No API-key guidance.
- Docs/skill reference the `agy` setup. Codex/Claude lanes unchanged.

## Success Criteria
- [ ] `consult -m gemini` runs through `agy --print` and returns a real review that **reflects file
      contents it read** (diff/repo), verified **end-to-end** on a spec, a plan, and a PR (headline-
      path lesson — not just mocked unit tests).
- [ ] The lane uses the **Pro** model class (not flash) — verified by the agreed mechanism.
- [ ] Auth is **subscription/OAuth**; no API key is required or used by the lane.
- [ ] Codev resolves and runs the **standalone CLI**, not the IDE symlink (a stale-PATH / IDE-symlink
      environment does not cause Codev to launch the Electron app).
- [ ] A missing/unauthed `agy` does **not** block porch runs: the lane is skipped non-blockingly and
      the user is told why; Codex/Claude still complete.
- [ ] Cost/usage reporting degrades gracefully for the lane (no `NaN`/crash; clear "no per-token
      data" indication).
- [ ] `codev doctor` reports real `agy` CLI presence + auth status with correct setup guidance.
- [ ] Existing consult/doctor/config/porch tests pass; new tests cover the `agy` dispatch, the
      non-blocking skip, the `pro` alias, and graceful cost degradation. Coverage does not regress.
- [ ] No regression to the Codex/Claude lanes.

## Constraints
- **Deadline 2026-06-18.** `agy` is available and verified today (v1.0.4), so the swap is buildable now.
- **Lean scope:** backend swap + auth + non-blocking skip + cost degradation. No redesign, no new
  abstraction layer, no changes to the Codex/Claude lanes beyond keeping the 3-way coherent.
- **Preserve** the agentic file-reading prompt builders (do not inline-and-strip).
- **First-run auth is interactive** (browser/code) and cannot be automated head-less — treat as a
  one-time user setup step (like the old `gemini /auth`), surfaced by `doctor`/docs.
- Keep skeleton ↔ `codev/` copies consistent across the four-tier resolver.

## Out of Scope
- **The Gemini Developer API pivot (former Approach A) — rejected by the architect.**
- A generic multi-provider gateway / model-router.
- The `harness.ts` Gemini-CLI **builder** path: out-of-scope-but-acknowledged (a *builder* using the
  `gemini` CLI as its coding agent also breaks for affected tiers; recommend a docs note + follow-up
  issue, not a rebuild here).
- `generate-image.ts` (already Gemini **API**, unaffected) — intentionally unchanged.
- `bench.ts` benchmark defaults — naming only if needed.
- `--dangerously-skip-permissions` (unnecessary given `--sandbox --add-dir` works).

## Open Questions
### Critical (architect decides)
- [ ] **Pro-pinning mechanism — and the default is Flash, so "do nothing" = wrong model.** Antigravity
      defaults to Gemini 3.5 **Flash**; Pro is chosen via the interactive **`/model`** slash command,
      which has no obvious `--print` (non-interactive) equivalent (no `--model` flag). The Plan must
      establish how a headless `--print` run uses **Pro**, candidates: (a) `/model` selection
      **persists** to config and is honored by later `--print` runs (set once at setup); (b) a
      writable `agy`/Antigravity settings/config file with a model field; (c) an env var; (d) the AI
      Ultra subscription default. **Architect input wanted** (product knowledge). Acceptance MUST
      include a positive *confirmation* that Pro (not Flash) served the review (e.g. via `agy` logs or
      a model-tier check), since the default silently degrades to Flash.
### Important
- [ ] **Binary resolution strategy:** pin `~/.local/bin/agy`, or search PATH then verify the binary
      is the CLI (reject the IDE symlink)? Recommended: prefer the known install path, fall back to a
      verified PATH lookup.
- [ ] **`doctor` auth probe without hanging:** a smoke `agy --print` on an unauthed machine prints an
      OAuth URL and waits ~30s. `doctor` must detect "needs login" quickly without blocking (short
      timeout; treat the auth prompt as "not authed").
- [ ] **`--print-timeout` tuning** for large/agentic reviews (default 5m) vs. consult's own timeouts.
- [ ] **Skip mechanism** (carried from prior spec): C1 drop the lane from the *effective* model set
      when unavailable, or C2 emit a defined neutral "skipped" artifact verdict logic treats as
      non-blocking. Plan selects.

## Security Considerations
- Auth tokens are managed by `agy` (OAuth), stored in the Antigravity app-support dir; Codev never
  reads/logs them.
- Prefer `--sandbox --add-dir <scoped dirs>` over `--dangerously-skip-permissions` to limit the
  agent's tool surface during reviews.
- Codev must execute the **verified** CLI binary (not an arbitrary PATH `agy`), avoiding accidental
  launch of the IDE or a shadowed binary.
- The reviewer transmits the same content as today (diff + role + repo files it reads) to Google over
  the subscription session; ensure parity (no extra data).

## Test Scenarios
### Functional
1. **Happy path:** `consult -m gemini` → `agy --print --sandbox --add-dir <root>` returns a review
   that demonstrably used file contents (e.g., references a changed file's actual code).
2. **Non-blocking skip:** no `agy` / not authed → porch 3-way **advances** (Codex+Claude complete;
   Gemini skipped; no blocking verdict).
3. **Pro model in use:** confirm the lane runs the Pro class (per agreed mechanism).
4. **`pro` alias:** `consult -m pro` resolves to the `agy` lane.
5. **Binary resolution:** with the IDE symlink first on PATH, Codev still invokes the real CLI.
6. **End-to-end headline path:** run on a spec, a plan, and a real PR.
### Non-Functional
1. Cost/usage degradation (no `NaN`; clear "no per-token data").
2. `doctor` reports agy presence + auth (authed / needs-login) without hanging.
3. No regression in Codex/Claude lanes; skeleton ↔ `codev/` schema/defaults consistent.

## Dependencies
- **External:** Antigravity CLI (`agy`, v1.0.4+) + a Google subscription (AI Ultra) login.
- **Internal:** `consult` dispatch + (preserved) prompt builders, `usage-extractor`, `porch`
  verdict/gate + consultation config, `doctor`, skeleton protocol JSONs, four-tier resolver.

## References
- Issue #778. Google blog (Gemini CLI → Antigravity CLI):
  https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Official CLI install: `https://antigravity.google/cli/install.sh` (Unix) — verified v1.0.4.
- Docs (JS-rendered; not extractable via fetch at spec time): antigravity.google/docs/cli-install,
  /cli-using, /cli-reference. Contract above established **empirically** instead.
- Prior related work: #680 (large-prompt handling), #878 (gemini lane model id).

## Risks and Mitigation
| Risk | P | I | Mitigation |
|---|---|---|---|
| Default model is **Flash**, not Pro (no `--model` flag) | High | High | Pro selection is mandatory; resolve the `--print` Pro-pinning mechanism in Plan w/ architect; acceptance requires positively confirming Pro served the review (default silently degrades to Flash). |
| Codev launches IDE symlink instead of CLI | Med | High | Pin/verify the real binary; binary-resolution test (#5). |
| Unauthed users block porch | Med | High | Non-blocking skip (C1/C2); doctor + docs guide one-time `agy` login. |
| First-run auth can't run in CI | Med | Med | Treat as one-time user setup; doctor detects "needs login" fast; skip in CI. |
| No token usage → cost reporting breaks | High | Low | Degrade cost rows gracefully (no NaN). |
| `agy` self-updates / contract drifts | Low | Med | Pin observed flags; e2e headline test catches breakage. |
| skeleton/`codev` config drift | Low | Med | Update both; consistency test. |

## Expert Consultation
**Iteration 1 (2026-06-01, on the prior Approach-A draft):** Gemini REQUEST_CHANGES (filesystem
access), Codex REQUEST_CHANGES (porch skip semantics, enterprise contradiction, doctor scope),
Claude APPROVE. The porch-skip and graceful-cost findings are carried forward; the filesystem-access
concern is now **moot** because Approach B preserves agentic file-reading by design.
**Iteration 2 (pending):** re-consult the Approach-B spec (porch flow / architect to direct gate
mechanics).

## Approval
- [ ] Architect review (spec-approval gate) — re-presented for Approach B
- [ ] Expert AI consultation on the Approach-B spec (iteration 2)

## Notes
Architect noted the work was "over-scoped as full SPIR" — this rewrite is deliberately lean (backend
swap + auth + skip safety + cost degradation). Plan sequencing: (1) `agy` dispatch in the gemini lane
(real-binary resolution, `--print --sandbox --add-dir`, role inlined, Pro-pinning) + non-blocking
skip; (2) graceful cost/usage degradation; (3) doctor + docs + tests; keep skeleton/`codev` in lockstep.

---

## Amendments
<!-- TICK amendments, if any, recorded here. -->
