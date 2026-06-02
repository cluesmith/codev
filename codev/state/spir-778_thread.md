# spir-778 — Gemini CLI → Antigravity CLI migration

## Context
Issue #778: Gemini CLI is being retired **June 18, 2026** (today is 2026-06-01 — 17 days out).
Google blog: transition Gemini CLI → Antigravity CLI. Codev uses `gemini` as a consult backend.

## Research findings (Specify phase)
- **What breaks June 18**: subscription/OAuth serving via the Gemini CLI & Code Assist for
  Google AI Pro / Ultra / free-individual tiers. Enterprise (Standard/Enterprise licenses,
  Google Cloud) unaffected.
- **What survives**: the Gemini **Developer API** (GEMINI_API_KEY, Google AI Studio) and Vertex AI.
  The API is NOT deprecated. (Wrinkle: from June 19, unrestricted API keys are blocked — keys must
  be scoped to the Generative Language API.)
- **Antigravity CLI (`agy`)**: Go-based, agentic, async, multi-agent. NOT a clean drop-in for
  Codev's one-shot `gemini --output-format json --model X` pattern. Headless/JSON support
  unconfirmed; not on any public package manager as of late May 2026. Migration guide page
  (antigravity.google/docs/gcli-migration) had no extractable technical detail yet.

## Codev's Gemini surface area (ground truth)
- `packages/codev/src/commands/consult/index.ts:37-40` — MODEL_CONFIGS.gemini =
  `{ cli: 'gemini', args: ['--model','gemini-3.1-pro-preview'], envVar: 'GEMINI_SYSTEM_MD' }`;
  spawn at ~682 with `--output-format json`, prompt via stdin, NODE_OPTIONS heap bump (#680).
- `packages/codev/src/lib/config.ts:88` — default consult models `['gemini','codex','claude']`.
- `packages/codev/src/commands/consult/usage-extractor.ts:19` — pricing key `gemini-3.1-pro`.
- `packages/codev/src/commands/doctor.ts:153-163` (dep check) + `266-274` (auth via `gemini --yolo`).
- `codev-skeleton/protocol-schema.json:155` model enum; `porch/next.ts:51` VALID_MODELS.
- 7 skeleton protocol JSONs reference "gemini"; docs (CLAUDE/AGENTS/README/consult skill).
- ~60 tests across consult/doctor/config/porch.

## Key decision (for spec-approval gate)
Three migration strategies explored in spec. Leaning: **pivot gemini lane → Gemini Developer API**
(robust, deadline-safe, API not retiring) **with graceful degradation** (claude+codex) when no key.
Antigravity-CLI adoption is risky right now (agentic mismatch, unconfirmed headless, not packaged).
The issue *title* literally says "Gemini CLI > Antigravity CLI" — flagging the divergence to the
architect since my research says the literal Antigravity path is the higher-risk one.

## Iteration-1 consultation (2026-06-01)
- **Gemini: REQUEST_CHANGES** (fatal): consult prompt builders rely on FILESYSTEM ACCESS
  (buildPRQuery writes diff to temp file → "Read the diff file from ${diffPath}"; impl review →
  "Explore the filesystem"). A single-shot Gemini API call can't read files. Fix: inline content
  (A1) or tool-use loop (A2). Also: enterprise contradiction; decide default-list.
- **Codex: REQUEST_CHANGES** (fatal): porch graceful-skip underspecified — `verdict.ts:27,46-47`
  defaults missing/short/error to REQUEST_CHANGES (blocks). Must define non-blocking skip (drop
  lane from effective set OR neutral skipped-artifact). Also: enterprise contradiction; doctor
  can't locally detect unrestricted keys (relax); scope other gemini surfaces.
- **Claude: APPROVE** with notes: `@google/genai ^1.0.0` ALREADY a dependency (lowers cost);
  clarify CLI-keep-vs-remove; `hermes` in VALID_MODELS but not schema enum (divergence precedent);
  add `pro` alias test; check Gemini API input-size limit for >500KB diffs.

## Decisions made in revision
- API is DEFAULT gemini backend; **keep legacy CLI as optional backend** (enterprise not regressed).
- API lane gets **inlined review content** (A1); drop "read from disk" instructions for that backend.
  Tool-use loop (A2) = future fidelity upgrade.
- **Keep `gemini` in default lists** + porch-safe graceful skip when uncredentialed (non-blocking).
- Doctor: report presence/reachability + June-19 guidance; no proactive unrestricted-key detection.
- harness.ts Gemini *builder* path = out-of-scope-but-acknowledged; generate-image already API
  (unaffected); bench = naming only.

## Status
- [x] Specify: research + ground-truth map done
- [x] Specify: spec drafted, 3-way consult iter-1, REVISED addressing all REQUEST_CHANGES
- [x] Specify: rebuttal written (778-specify-iter1-rebuttals.md)
- [x] **GATE: spec-approval REQUESTED (2026-06-01) — WAITING FOR HUMAN**. Architect notified.
- [ ] After approval → Plan phase

## ARCHITECT OVERRODE → Approach B (Antigravity `agy`), 2026-06-02
Architect rejected the API pivot at the gate. Corrected my stale research: `agy` IS packaged +
documented now. Directive: swap gemini lane → `agy`; PRESERVE agentic file-reading (don't
inline-strip); KEEP Pro model (not flash); SUBSCRIPTION/OAuth (AI Ultra, ~3x cheaper, not API key);
keep porch-safe non-blocking skip + graceful cost degradation; keep it LEAN (CLI swap, not redesign).

## Empirical agy verification (2026-06-01) — done
Installed real CLI v1.0.4 via official `antigravity.google/cli/install.sh` (SHA512-verified) →
`~/.local/bin/agy`. (PATH `agy` = IDE symlink, NOT the CLI → Codev must pin/verify the real binary.)
- Headless: `agy --print` (`-p`/`--prompt`), `--print-timeout` (5m default). ✅
- File-reading: `--print --sandbox --add-dir <dir>` reads files NON-interactively WITHOUT
  `--dangerously-skip-permissions` (verified: read planted file → BANANA-42). ✅ Use sandbox+add-dir.
- Auth: OAuth/subscription (AI Ultra), one-time interactive browser/code login; token persists in
  ~/Library/Application Support/Antigravity. No API key. First-run auth can't run head-less/CI.
- NO `--model` flag → Pro-pinning is OPEN (self-id probe timed out). NO JSON/usage → degrade cost.
  NO role flag → fold role into prompt. Instruction-following works.
- harness blocked `--dangerously-skip-permissions` (I added it unprompted) — correct, and we don't
  need it.

## Spec rewritten to Approach B (lean) — committed
Replaced the Approach-A spec wholesale. Pivot rejected→out of scope; kept porch-safe skip + graceful
cost from prior; preserved agentic file-reading prompts.

## ⏸ AWAITING ARCHITECT (still at spec-approval gate; NOT approved)
1. **Pro-pinning mechanism** (CRITICAL open Q): no `--model` flag; how to guarantee Pro not flash?
   ⚠️ **Found via docs: agy DEFAULTS to Gemini 3.5 Flash, NOT Pro.** Pro is chosen via interactive
   `/model` slash command (Gemini 3.1 Pro High/Low; `-preview` suffix dropped post-AG-2.0). So naïve
   `agy --print` = Flash = violates architect priority #2. Open: how does `--print` use Pro?
   (persisted `/model` choice? config file? env? subscription default?) — needs architect/product
   knowledge. Acceptance must POSITIVELY confirm Pro served the review. Spec + risks updated.
2. **Gate mechanics**: how to re-present — re-run 3-way consult on the B-spec (needs porch to reopen
   specify), or approve directly given "keep it lean"? Architect to direct (strict mode: I won't
   touch porch state / approve).
User wanted to "clarify" the file-access AskUserQuestion — now empirically answered (sandbox+add-dir,
no dangerous flag). Held the outward consult-rerun + afx notify pending their return.
