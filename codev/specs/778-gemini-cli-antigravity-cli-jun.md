# Specification: Migrate the Gemini consult lane to the Antigravity CLI (`agy`)

## Metadata
- **ID**: spec-2026-06-01-778-gemini-antigravity-cli
- **Status**: APPROVED 2026-06-02 (spec-approval gate; Approach B) · **Amendment A1** added same day
  (Gemini Developer API as co-equal backend) — combined design to be reviewed by the Plan's consult
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
2. ~~Keep the Pro model.~~ **SUPERSEDED (2026-06-02): do NOT pin the model — use `agy`'s default.**
   The architect decided against Pro-pinning to keep the swap lean. The lane uses whatever `agy`
   defaults to (currently **Gemini 3.5 Flash (High)**). **Accepted tradeoff:** Flash < Pro for review
   depth, accepted in exchange for avoiding a brittle, non-obvious `--print` model-pinning mechanism.
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
- **No `--model` flag; the lane uses `agy`'s default model (per architect decision — no pinning).**
  Per Antigravity docs the CLI defaults to **Gemini 3.5 Flash (High)**; Pro is selectable only via the
  interactive **`/model`** slash command (no `--print` equivalent). The architect decided **not** to
  pin Pro (keep it lean), so the lane simply uses the default — currently Flash. No action needed for
  model selection. (Binary internals show a model-tier system; a self-id probe timed out, so the
  served model id isn't reliably introspectable via `--print` — noted, not blocking.)
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
> **AMENDED 2026-06-02:** the Gemini lane supports **two co-equal backends** selected by config +
> auto-detect (see **Amendment A1**): **`agy`** (below) and the **Gemini Developer API**. The bullets
> below describe the `agy` backend; the API backend's desired behavior is in Amendment A1. Both must
> satisfy the non-blocking-skip, graceful-degradation, and "model id stays `gemini`" requirements.

- The Gemini consult lane (agy backend) invokes **`agy --print --sandbox --add-dir <repoRoot>`** (role
  folded into the prompt), reaching Gemini via the user's **subscription/OAuth** auth, with the
  reviewer still **reading the diff/repo from disk** (agentic behavior preserved).
- The lane uses `agy`'s **default** model (no pinning, per architect decision — currently Gemini 3.5
  Flash). The **model identifier stays `gemini`** everywhere (`MODEL_CONFIGS` key, `VALID_MODELS`,
  `protocol-schema.json` enum, default model lists, user-facing config, the `pro` alias) — only the
  *backend* changes; **no rename** to `agy`/`antigravity`.
- Codev invokes the **real `agy` CLI deterministically**, never the IDE symlink; if it cannot resolve
  a binary that satisfies the headless contract, it **skips the lane** (below) rather than launching
  the IDE.
- A missing/unauthed/timed-out/invalid-binary `agy` lane is a **non-blocking skip**: the lane emits
  **`VERDICT: COMMENT` / `SUMMARY: Skipped (agy unavailable: <reason>)`**, which `verdict.ts` treats
  as non-blocking (`allApprove` accepts `COMMENT`; verified `:54-59`). Porch-orchestrated runs still
  advance (Codex/Claude complete; Gemini reported skipped — never a blocking `REQUEST_CHANGES`/
  `CONSULT_ERROR` caused merely by unavailability).
- Cost/usage rows **degrade gracefully** (no `NaN`; show e.g. "n/a (subscription)").
- `codev doctor` checks for the real `agy` CLI + auth and gives correct, current setup guidance
  (official install script; one-time `agy` login). No API-key guidance.
- Docs/skill reference the `agy` setup. Codex/Claude lanes unchanged.

## Iteration-2 Decisions (resolved from 3-way re-consult, 2026-06-02)
Concrete resolutions to reviewer feedback (Codex REQUEST_CHANGES, Gemini COMMENT, Claude
REQUEST_CHANGES). These keep scope lean while removing ambiguity:
- **Model identifier stays `gemini`** — no rename anywhere; only the backend changes. (Claude must-fix.)
- **Non-blocking skip = C2 (decided, not deferred):** the lane's wrapper emits `VERDICT: COMMENT` +
  a `SUMMARY: Skipped (...)` line when `agy` is unavailable. `verdict.ts` treats `COMMENT` as
  non-blocking (verified `:42,:54-59`); a *missing* verdict would default to `REQUEST_CHANGES` and
  block, so the explicit `COMMENT` is mandatory. (Gemini's concrete mechanism; resolves Codex's
  "observable skip contract" ask.)
- **Fast auth-skip:** an unauthed `agy --print` prints an OAuth URL and waits ~30s. The wrapper
  **streams stdout/stderr and terminates the child early when the OAuth URL is detected**, emitting
  the `COMMENT` skip — so an unauthed lane doesn't block the run for 30s. (Gemini.)
- **Binary resolution + rejection rule:** prefer the known install path (`~/.local/bin/agy`), else a
  PATH lookup that is **verified** to be the real headless CLI (responds to `--print`/`--version` as
  the CLI, not the IDE Electron launcher). If no valid CLI is found (missing, or only the IDE
  symlink/stub), treat the lane as **unavailable → `COMMENT` skip with actionable guidance** — never
  launch the IDE. (Codex + Claude.)
- **Timeout ownership:** Codev manages its **own** timeout and SIGTERMs the child if `agy` hangs
  past it; it does not rely solely on `--print-timeout`. (Claude.)
- **Output handling:** `agy --print` returns **plain text** = the review. `extractReviewText`'s
  current `gemini` branch (`JSON.parse(output).response`) must be **adapted to return the raw output**
  for the agy backend (else it throws on plain text); usage/cost extraction returns null → cost rows
  degrade gracefully. (Claude.)
- **Follow the `hermes` precedent** (`index.ts:39,651-668,1587`): a CLI model with `envVar:null`,
  role folded into the prompt (`${role}\n\n---\n\n${query}`), and the **temp-file pattern when the
  prompt exceeds `CLI_PROMPT_INLINE_MAX_CHARS` (100k)** — which also handles `E2BIG`/large-diff
  inlining (Gemini's concern). The existing `buildPRQuery` already writes the diff to a temp file the
  reviewer reads, so large content stays file-referenced. (Claude + Gemini.)
- **`pro` alias:** kept **as-is** (historical name; resolves to the `gemini`/agy lane). No rename, no
  deprecation warning — leanest. (Claude.)
- **`harness.ts` `GEMINI_HARNESS` is explicitly untouched** and is a **separate concern** from the
  consult `MODEL_CONFIGS.gemini` lane; this spec changes only the consult lane. (Claude.)

## Success Criteria
- [ ] `consult -m gemini` runs through `agy --print` and returns a real review that **reflects file
      contents it read** (diff/repo), verified **end-to-end** on a spec, a plan, and a PR (headline-
      path lesson — not just mocked unit tests).
- [ ] The lane uses `agy`'s **default** model (no pinning) — per architect decision; Flash is the
      accepted default.
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
- [ ] **(Amended) API backend works:** with `GEMINI_API_KEY` set and the backend = `api`, the lane
      returns a real review using a **Pro-class** model (`gemini-3.1-pro-preview`), parses
      `usageMetadata` into **real cost rows**, needs **no interactive login** (CI-friendly), and works
      with **inlined review content** (no filesystem dependency).
- [ ] **(Amended) Selector works:** `consult.gemini.backend` = `agy | api | auto` routes to the
      correct backend; `auto` resolves deterministically per the documented precedence; both backends
      honor the non-blocking skip and "model id stays `gemini`" rules.

## Constraints
- **Deadline 2026-06-18.** `agy` is available and verified today (v1.0.4), so the swap is buildable now.
- **Lean scope:** backend swap + auth + non-blocking skip + cost degradation. No redesign, no new
  abstraction layer, no changes to the Codex/Claude lanes beyond keeping the 3-way coherent.
- **Preserve** the agentic file-reading prompt builders (do not inline-and-strip).
- **First-run auth is interactive** (browser/code) and cannot be automated head-less — treat as a
  one-time user setup step (like the old `gemini /auth`), surfaced by `doctor`/docs.
- Keep skeleton ↔ `codev/` copies consistent across the four-tier resolver.

## Out of Scope
- ~~The Gemini Developer API pivot — rejected.~~ **AMENDED 2026-06-02 (post-approval): the Gemini
  Developer API is now IN scope as a co-equal backend alongside `agy`.** See **Amendment A1**.
- A generic multi-provider gateway / model-router (the two Gemini backends + a selector is **not**
  a generic gateway — it is scoped to this one lane).
- The `harness.ts` Gemini-CLI **builder** path: out-of-scope-but-acknowledged (a *builder* using the
  `gemini` CLI as its coding agent also breaks for affected tiers; recommend a docs note + follow-up
  issue, not a rebuild here).
- `generate-image.ts` (already Gemini **API**, unaffected) — intentionally unchanged.
- `bench.ts` benchmark defaults — naming only if needed.
- `--dangerously-skip-permissions` (unnecessary given `--sandbox --add-dir` works).

## Open Questions
### Critical
- **RESOLVED (2026-06-02): model selection.** The architect decided **not to pin Pro** — the lane
  uses `agy`'s default model (currently Gemini 3.5 Flash). No model-selection work; no `--model`
  handling. (This removes what was the only critical open question.)
### Important — mostly resolved by Iteration-2 Decisions
- [x] Binary resolution strategy → **resolved** (prefer `~/.local/bin/agy`; else verified PATH CLI;
      reject IDE stub → skip).
- [x] `doctor`/consult auth probe without hanging → **resolved** (stream output, detect OAuth URL,
      terminate early → `COMMENT` skip; `doctor` uses a short timeout and reports "needs login").
- [x] Skip mechanism → **resolved** (C2: emit `VERDICT: COMMENT`).
- [ ] **`--print-timeout` value + Codev's own timeout value** for large/agentic reviews — exact
      numbers are a Plan detail (ownership is decided: Codev manages its own timeout).
- [ ] **Confirm the precise `agy --print` prompt-delivery** (positional arg vs stdin) in the Plan, to
      pick inline vs temp-file per the `hermes` precedent (empirically: positional arg works; large
      content already goes via the diff temp file).

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
2. **Non-blocking skip (unit):** no `agy` / not authed / IDE-stub-only → the lane emits
   `VERDICT: COMMENT` (Skipped), and `allApprove` is not blocked by it.
2b. **Non-blocking skip (porch-orchestrated, end-to-end):** in an actual porch SPIR run with `agy`
   missing/unauthed, **phase progression continues** (the gate isn't blocked by the skipped Gemini
   lane) — this is the core failure being prevented, so it must be exercised, not just unit-tested.
   (Codex.)
3. **`pro` alias:** `consult -m pro` resolves to the `agy` lane (note: the alias name is historical;
   the lane uses agy's default model, not necessarily "Pro").
4. **Binary resolution:** with the IDE symlink first on PATH, Codev still invokes the real CLI.
5. **End-to-end headline path:** run on a spec, a plan, and a real PR.
6. **(Amended) API backend happy path:** backend = `api` + `GEMINI_API_KEY` → real review via
   `gemini-3.1-pro-preview`, with real cost rows from `usageMetadata`, no interactive login.
7. **(Amended) Selector:** `agy | api | auto` each route correctly; `auto` precedence is deterministic
   and matches the documented (architect-approved) rule.
8. **(Amended) API CI-friendliness:** the `api` backend completes in a non-interactive/CI context
   (env-var auth only, no OAuth prompt).
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
| Lane uses Flash (agy default), weaker reviews than Pro | High | Low | **Accepted tradeoff** per architect decision (no pinning, for leanness). Revisit if review quality suffers; Pro could be added later if `agy` exposes a non-interactive selector. |
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
**Iteration 2 (2026-06-02, on this Approach-B spec):** Codex **REQUEST_CHANGES**, Gemini **COMMENT**,
Claude **REQUEST_CHANGES**. All substantive points addressed (see Iteration-2 Decisions + rebuttal
`778-specify-iter2-rebuttals.md`): fixed the stale Desired-State "Pro" line (unanimous); stated the
model id stays `gemini` (Claude); adopted the concrete `COMMENT`-verdict skip mechanism (Gemini,
resolving Codex's observable-contract ask); added fast auth-skip, binary rejection rule, timeout
ownership, `extractReviewText` adaptation, `hermes` precedent, `pro`-alias decision, harness
distinction, and a porch-orchestrated progression test. Code claims verified against the tree.

## Approval
- [ ] Architect review (spec-approval gate) — re-presented for Approach B
- [ ] Expert AI consultation on the Approach-B spec (iteration 2)

## Notes
Architect noted the work was "over-scoped as full SPIR" — this rewrite is deliberately lean (backend
swap + auth + skip safety + cost degradation). Plan sequencing: (1) `agy` dispatch in the gemini lane
(real-binary resolution, `--print --sandbox --add-dir`, role inlined, agy's default model) +
non-blocking skip; (2) graceful cost/usage degradation; (3) doctor + docs + tests; keep
skeleton/`codev` in lockstep.

---

## Amendments

### Amendment A1: Gemini Developer API as a co-equal second backend (2026-06-02)

**Status:** Added by the architect at spec-approval (the gate was approved *with* this requirement).
Reverses the earlier "API out of scope" decision.

**Summary:** The Gemini consult lane supports **two co-equal backends**, chosen by a config knob +
auto-detect. Each environment picks the tradeoff that fits it.

**Backend 1 — `agy` / OAuth subscription** (the body of this spec): agentic file-reading
(`--print --sandbox --add-dir`), `agy`'s **default** model (currently Flash), cheap (subscription,
~3× cheaper for our volume). Keeps all Iteration-2 work: `COMMENT`-verdict non-blocking skip, fast
auth-skip, binary-resolution rejection rule, `hermes` precedent, graceful (no-per-token) cost
degradation. Strength: cheap + agentic context. One-time interactive login (not CI-friendly).

**Backend 2 — Gemini Developer API / `GEMINI_API_KEY`** (the former Approach A1, now in scope):
- **Inlined review content** — a single API `generateContent` call **cannot read files
  agentically**, so the lane feeds the diff + spec/plan + relevant changed-file text into the request
  and drops the "read from disk / explore filesystem" instructions for this backend (reuses the
  iter-1 A1 design). Large content uses the existing temp-file/size handling.
- **Pro-class model:** this backend *can* select a model → use **`gemini-3.1-pro-preview`** (Pro ≫
  Flash for review quality). This is the path to Pro-quality reviews.
- **Real cost rows:** parse the API response `usageMetadata` (prompt/candidates tokens) into the
  existing usage/cost pipeline (no degradation — full token data).
- **CI-friendly:** env-var auth (`GEMINI_API_KEY`, fallback `GOOGLE_API_KEY`), **no interactive
  login** → works headless/CI.
- Role → API `systemInstruction`. `@google/genai` is already a dependency.

**Backend selection (DESIGN IN PLAN — do not hard-code silently):**
- Config knob **`consult.gemini.backend: agy | api | auto`** (exact name/shape is a Plan decision).
- **`auto`** must resolve deterministically, but its **precedence is a real cost-vs-quality
  tradeoff** (agy = cheap/Flash/agentic vs api = pricier/Pro/full-usage/CI). The Plan must **propose**
  the auto precedence and **flag it explicitly for the architect** — it is NOT to be silently
  hard-coded. (E.g. candidate: prefer `api` when `GEMINI_API_KEY` is present (Pro+usage+CI), else
  `agy` if authed, else skip — but this is exactly the call to surface, not assume.)
- Both backends share: the `gemini` model identifier (no rename), the non-blocking `COMMENT` skip
  when their backend is unavailable, and the existing prompt/role plumbing where applicable.

**Net:** `api` = Pro + CI + full usage data; `agy` = cheap subscription + agentic reading — each
environment picks. Combined design (both dispatch paths + the selector) is reviewed by the **Plan's**
3-way consult, per the architect.

**Spec sections updated:** Out of Scope (un-scoped API), Desired State (dual-backend note),
Success Criteria (+API backend, +selector, +CI), Test Scenarios (#6 API happy path, #7 selector,
#8 CI-friendliness). HOW (dispatch + selector mechanism) is deferred to the Plan.

<!-- Further TICK amendments, if any, recorded below. -->
