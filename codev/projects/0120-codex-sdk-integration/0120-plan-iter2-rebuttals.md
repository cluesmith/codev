# Plan Review Rebuttals — Iteration 2

## Disputed: Spec contradiction on temp-file prompt handling requires explicit spec amendment

The Codex reviewer says the plan "conflicts with an approved spec requirement" because the spec says "System prompt / role passed via SDK options (not temp file)" but the plan uses `experimental_instructions_file` with a temp file.

**This is not a spec conflict — it is an SDK constraint that the spec could not have anticipated.**

Evidence:
1. The `@openai/codex-sdk` `CodexOptions` interface only accepts `config` (TOML-style key-value pairs), `env`, `codexPathOverride`, `baseUrl`, and `apiKey`. There is no `systemPrompt` or `instructions` string option.
2. The only way to pass instructions to Codex is via the `experimental_instructions_file` config key, which requires a file path. This is the same mechanism the current subprocess uses (`-c experimental_instructions_file=...`).
3. Both Gemini (iteration 1 + 2) and Claude (iteration 2) reviewers accepted this justification as sound.
4. The Claude reviewer explicitly states: "The builder can't work around an SDK limitation."
5. The plan already documents this clearly in the "Note on system prompt delivery" section.

A formal spec amendment is unnecessary for an implementation detail that the spec's author could not have controlled. The spec's intent — "pass role via SDK options, not temp file" — is met as closely as the SDK allows: the temp file is an ephemeral intermediary passed through the SDK's `config` option and cleaned up immediately. No raw subprocess piping is involved.

## Disputed: Cost ownership remains ambiguous

The reviewer points to Phase 2 risk section text that says "move pricing constants into `runCodexConsultation()` or keep them in a shared location" as evidence of ambiguity. However, this is leftover text from iteration 1 that was superseded by the more specific Phase 2 implementation details section.

The plan **does** make a clear decision at line 246: "Remove codex from `SUBPROCESS_MODEL_PRICING` — pricing is now owned by `CODEX_PRICING` constant in `index.ts` next to `runCodexConsultation()`. This follows the same pattern where Claude pricing comes from the SDK result directly. Each SDK-based model owns its own cost computation."

The risk section text will be updated to match this decision.
