# Delta review rebuttal — behavioural-measurement amendment (D5 / M12)

Scoped review of the D5 amendment only: spec M12 (a/b/c), Appendix D, D5, T14,
plan Step 1b, plan Verify Phase.

| Model | Verdict | Confidence | Issues | Accepted | Disputed |
|---|---|---|---|---|---|
| Gemini | **APPROVE** | HIGH | 0 | — | 0 |
| Codex | **REQUEST_CHANGES** | HIGH | 2 | 2 | 0 |
| Claude | **APPROVE** | HIGH | 0 | — | 0 |

**I dispute nothing.** Both of Codex's findings are genuine defects in material
I wrote, and one of them made a metric literally unmeasurable.

**On the split verdict**: Gemini and Claude both verified the *data-availability*
claims (which were correct) and approved. Codex went further and checked whether
the *metric definitions* actually resolve against the data — which is where both
defects were. Two APPROVEs did not make the amendment sound, and the majority
was not the signal worth trusting here.

---

## Codex (REQUEST_CHANGES) — both accepted

### CX-1 — "B2 is not derivable as specified"

> *B2 says "rounds to unanimous approve," yet in real SPIR data the terminal
> phase verdict is **never** 3× `APPROVE` (0/48 plan phases across the
> 17-project SPIR baseline).*

**Accepted, and independently verified before acting on it.** I re-derived the
figure rather than taking the claim on trust:

```
terminal plan-phases with verdicts: 48
unanimous APPROVE:                   0

  20  (APPROVE, APPROVE, REQUEST_CHANGES)
  12  (APPROVE, REQUEST_CHANGES, REQUEST_CHANGES)
   7  (REQUEST_CHANGES, REQUEST_CHANGES, REQUEST_CHANGES)
   5  (APPROVE, COMMENT, REQUEST_CHANGES)
   …
```

Codex is exactly right. **Porch advances a plan phase after the builder rebuts,
not on consensus** — so a "rounds to unanimity" counter would never resolve, and
B2 would have been a metric that silently never fired. Worse, it would have
*looked* fine: the script would run, emit a number, and that number would be
meaningless.

This is a nice illustration of the difference between "the data exists" and "the
metric resolves." I verified the former carefully (Appendix D §1–2, which all
three reviewers confirmed) and then failed to check the latter for my own metric
definition.

**Changed:**

- **B2 redefined** as *review rounds per plan phase* = `max(iteration)` per
  `plan_phase`. Directly derivable, and it measures the friction the metric was
  reaching for.
- **Measured baselines added to Appendix D**, so the spec now publishes real
  numbers rather than a promise to produce them:

  | Metric | Baseline |
  |---|---|
  | B1 `REQUEST_CHANGES` rate | **51.9%** (n=160; APPROVE 41.2%, COMMENT 6.9%) |
  | B2 rounds per plan phase | mean **1.12**, median 1, max 2 (n=49) |
  | B4 rounds per project | mean **3.06**, median 3 (n=18) |

- **Weighting corrected as a consequence.** Computing the baselines exposed
  something the original draft implied but the data does not support: **B2's
  observed range is 1–2 with mean 1.12** — almost no variance, so it cannot
  detect a subtle regression. B2 and B4 are now explicitly **advisory**, and
  **B1 is named the load-bearing metric**. It was already the soft trigger's
  basis; now it is labelled as such and the threshold is concrete: >25% relative
  on 51.9% means **above ~64.9%**.

The redefinition also made the empirical finding worth recording in its own
right — *phases advance on rebuttal, not unanimity* — since anyone later reading
the CMAP verdict data will otherwise expect unanimity and find none.

### CX-2 — "B5/T14 must be reconciled"

> *A rolling machine-local `consult stats` snapshot is not a committed-artifact
> metric and cannot satisfy T14's deterministic "same commit ⇒ same B1–B5
> numbers" requirement.*

**Accepted — a straightforward self-contradiction, both halves written by me in
the same amendment.** Appendix D §2 correctly labels B5 prospective-only and
machine-local; T14 then demanded determinism across B1–**B5**. Both cannot hold.

**Changed:**

- **T14's determinism assertion is scoped to B1–B4** (the committed-artifact
  metrics).
- **B5 is explicitly excluded** from that assertion, labelled *advisory and
  non-deterministic*, and confirmed to drive **no rollback trigger**. It was
  already absent from the hard and soft trigger rows; it is now named in the
  advisory row so the exclusion is deliberate rather than incidental.

Worth stating why B5 is kept at all rather than dropped: cost and duration per
phase are genuinely useful context when interpreting a B1 movement, even though
they cannot support a causal claim. Keeping it labelled is better than losing
the signal — the failure mode was pretending it was reproducible.

---

## Gemini (APPROVE) and Claude (APPROVE)

Both verified the data-availability claims against the repo and confirmed no
usable source was missed:

- Gate-rejection counts unminable — no `rejected` state; `requested_at`
  overwritten on re-request.
- Consult token/cost prospective-only — logs gitignored at `.gitignore:59`;
  `consult stats` backed by a local 30-day SQLite DB.
- `history[].reviews[].verdict` present for 17 SPIR projects only.

Gemini specifically endorsed the **n = 1 hard trigger on B3**, reasoning that
scar rules exist *because* the catastrophic failure already occurred once, so a
single verified recurrence is sufficient grounds to revert compression. That
matches the intent and is worth recording, since a single-incident trigger looks
aggressive without that justification.

Both also confirmed rollback targeting (trims revertible, repairs not), baseline
sequencing (Phase 1, before any content-altering phase), and that the
add/remove confound is *acknowledged rather than solved* — acceptable only
because the spec downgrades its claim to total-effect observation.

---

## Summary of changes

| Change | Driver |
|---|---|
| B2 redefined: rounds per plan phase, not rounds-to-unanimity | CX-1 |
| Empirical note: 0/48 terminal phases unanimous; phases advance on rebuttal | CX-1 |
| Measured baselines published in Appendix D (B1 51.9%, B2 1.12, B4 3.06) | CX-1 (+ builder) |
| B2/B4 demoted to advisory; B1 named load-bearing; soft threshold made concrete (~64.9%) | builder, from the measured data |
| T14 determinism scoped to B1–B4 | CX-2 |
| B5 labelled advisory/non-deterministic, excluded from triggers | CX-2 |
| Plan Step 1b updated with the reproduction targets | CX-1, CX-2 |

## Status

Amendment complete. Spec and plan updated and committed.

Returning to the **`plan-approval`** gate for the architect to re-approve the
spec delta and the plan together, per the directive.
