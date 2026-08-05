# Phase 6 — Iteration 1 Rebuttals

**Verdicts**: codex `REQUEST_CHANGES` (HIGH) · claude `REQUEST_CHANGES` (HIGH)

Both reviewers independently named the **same two** defects. Everything raised was accepted and
fixed; nothing is rebutted. Each claim was checked against the source before acting.

---

## Both reviewers — the config-layer list was factually wrong

I wrote "defaults → global → project → per-engineer → env". There is no env layer, and I had
dropped the framework-cache one. Verified against `config.ts`, whose own header states the five:

1. built-in defaults
2. `<cache>/config.json` — remote framework base config
3. `~/.codev/config.json` — global, per-user
4. `.codev/config.json` — project, checked in
5. `.codev/config.local.json` — project, per-engineer, gitignored

Corrected to the real list in both trees. Worth noting how it happened: I wrote the sentence from
memory of how config stacks usually look rather than from the file, in a document whose entire
value is being the thing people trust instead of reading the code. Every other constant in this
doc had been read out of the source; this one line was not, and it was the one that was wrong.

## Both reviewers — `--model-id` was undocumented

The flag ships, is parsed, and appears in `--help` (`cli-options.ts:39`), but was absent from the
reference. Verified before writing it up.

The irony is pointed: `--model-id`'s own code comment cites "registered, parsed, documented in
`--help`, and inert" as the failure class it was written to avoid — and it then went into the
reference doc as *undocumented*. Same gap, one layer out.

Added a **Model Selection Options** section covering the distinction users actually trip on
(`-m/--model` picks the *lane*; `--model-id` picks the *model that lane runs*), plus precedence
(`--model-id` > `consult.models.<lane>` > shipped default), the supported lanes, the `hermes` hard
error, and syntax-only validation. Cross-linked from `consult.models`.

## codex — `consult.pricing` values and failure modes underspecified

Correct. Verified in `validatePricing`: `codex` is the only accepted lane (any other key errors),
and each of the three rates must be a finite, non-negative number. The doc had only said "all three
required together". Now states the lane restriction, the numeric constraint, and *why* a partial
object errors rather than being completed from built-ins.

## claude — `--model-id` also arms the gemini hard-failure path

The sharpest catch of the four, because my text was subtly wrong rather than merely incomplete.
I had written that configuring `consult.models.gemini` turns a rejected id into a hard failure.
The gate at `index.ts:1209` is `code !== null && code !== 0 && choice && !timedOutProducing` — it
keys on **`choice`**, i.e. any resolved id, whichever source supplied it. A reader following my
version would think `--model-id` left the lane in non-blocking skip mode; it does not.

Rewritten around the resolved id rather than the config key, and now also names what still skips
even *with* an id — agy absent, unauthenticated, timed out, or signal-killed — since those are
environment causes, not the model's fault.

## claude — `consult.pricing.codex` framing (nit)

Also correct. `getCodexCost` is `configured ?? CODEX_PRICING[model]`, so the override outranks the
shipped table for **every** model, not just ones Codev has no rates for. My framing implied it only
applied to unknown models, which would leave someone surprised when it silently repriced a known
one. Reworded, with the practical consequence stated: once set, it applies to whatever the codex
lane runs, so it is worth revisiting when the model changes.

---

## Verification

`diff` between `codev/` and `codev-skeleton/` copies is **empty**. Build ✓, full unit suite green.
