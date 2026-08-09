# air-1288 — consult: shipped default lane models → claude-opus-5 / gpt-5.6-sol

Protocol: AIR (strict). Issue #1288.

## Implement

Scope was exactly as issued — two hardcoded ids, pricing, docs, a guard test.

**Model ids.** Rather than inlining the new strings at the two call sites, hoisted them to
exported constants in `consult/index.ts`:

- `DEFAULT_CLAUDE_MODEL = 'claude-opus-5'`
- `DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'`
- `DEFAULT_CODEX_REASONING_EFFORT = 'medium'`

Two reasons: the guard test (issue item 4) needs something CI-safe to assert against, and #1286
turns these exact values into config *fallback defaults* — having them already named makes that
rebase a one-liner instead of a re-extraction.

**Pricing.** Verified against OpenAI's own pricing page (`developers.openai.com/api/docs/pricing`,
fetched 2026-07-30), not an aggregator: gpt-5.6-sol standard tier is **$5.00 input / $0.50 cached
/ $30.00 output** per 1M. (Aggregator results agreed, but the issue asked for the official page.)

Turned `CODEX_PRICING` from a bare rate triple into a `Record<modelId, rates>` and exported
`computeCodexCost(model, input, cached, output): number | null`. An unknown model id now returns
`null` instead of being billed at another model's rates — which is the issue's stated cost rule,
and it also means #1286's configurable models can't silently inherit gpt-5.6-sol's rates once a
workspace points the lane elsewhere. Documented the one known gap: OpenAI publishes a separate
higher long-context tier that we don't model, so very large consultations under-report.

**Test hygiene.** `codex-sdk.test.ts` had a *copy* of `CODEX_PRICING` and its own local
`computeCodexCost` — so its "cost computation" suite would have kept passing against gpt-5.4 rates
forever while the shipped rates drifted. Rewired it to import the real exported function. Worth
knowing this pattern exists elsewhere: a test that reproduces the constant it's testing is testing
nothing.

New `consult/__tests__/default-models.test.ts` pins both ids + the effort. The `-sol` suffix is the
thing most likely to get "corrected" by a future drive-by (plain `gpt-5.6` and `gpt-5.6-codex` were
both live-probed and rejected on a ChatGPT account), so the test comment says so explicitly.

**Docs.** `consult.md` Models table gained a "Shipped default model id" column plus a cost-reporting
note; copied verbatim to the skeleton. CLAUDE.md/AGENTS.md's Multi-Agent Consultation section named
GPT-5.4 with a wrong id (`gpt-5.4-codex` — the code never used that); fixed, added the claude lane
which the section had simply omitted, and verified the two files stay byte-identical.

## Coordination

#1286 has no PR open as of 2026-07-30, so this lands first. Per the issue, #1286's
"default preservation" vectors must then assert the NEW ids.

## PR — at the `pr` gate

PR #1301. porch checks all green (build, tests, pr_exists, e2e_tests). Stopped at the gate;
have not run `porch approve`.

**Worth knowing for anyone else building in this repo today:** a fresh builder worktree here has
**no `node_modules`**. `pnpm build` and `pnpm test` both "succeed" with exit 0 when you pipe them
through `tail`, because the pipeline reports tail's status — the real output is `sh: tsc: command
not found`. I briefly believed the build was green off exactly that. Run `pnpm install` from the
worktree root first, and capture exit codes explicitly (`cmd > log 2>&1; echo $?`) rather than
piping. Also: `cd packages/codev && pnpm ...` in a backgrounded Bash call didn't take — `pnpm -C
packages/codev ...` did.

**CI red, not ours.** `Tower Integration Tests` fails on this branch (twice). Diagnosed rather than
re-rolled: `send-integration.e2e.test.ts` declares its `afterAll` with an explicit `10_000` budget
(line 273) that overrides the config's `hookTimeout: 300000`. Teardown makes two *unbounded*
deactivate `fetch`es plus a 2s SIGTERM wait plus four `rmSync` — over 10s on a loaded ubuntu runner.
All 5 tests pass; only teardown blows up. The suite runs 5/5 in 1.76s locally on this branch, and
our diff touches no Tower code. Same file already carries a "fix flaky" commit (1546ced5), and its
`beforeAll` gets `120_000` — the asymmetry reads as an oversight.

Deliberately did **not** fix or skip it: skipping costs 5 real integration tests to land a two-line
model-id change, and both edits are outside #1288. Escalated to the architect at the gate with the
PRFT and a fix proposal (raise the budget, bound the fetches). If a sibling builder hits the same
red job, this is why — it is not your diff.
