# Spec 1995 — specify iteration 1 rebuttals

Both reviewers requested changes. Every point was accepted; there is no disagreement to
argue. Changes are in commit d1c191e23.

## Codex (REQUEST_CHANGES)

**1. Ride-along cadence internally inconsistent** ("at most once per 600 s" vs a 540 s
prefetch). *Accepted.* Decision 3 now states the rule exactly:
- only the open lists make a call due;
- a call carries the windows iff they have no positive entry, or their age at dispatch is
  ≥ `SEARCH_TTL − LIST_TTL` (420 s), except inside their own failure window.

600 s is defined as a **maximum data age**, as today. The windows are re-queried at least
420 s apart, and never in a call of their own. The Success Criterion, Desired State model
note, and Test Scenarios 2–4 are aligned to that rule.

**2. Churn description inconsistent** ("every seventh"). *Accepted, with the arithmetic
now explicit.* With a 420 s threshold and 60 s refreshes, the windows ride on the first
refresh at age ≥ 420 s, i.e. every seventh or eighth (420–480 s), about 8/h. Codex's
"every ninth" assumed prefetching one *60 s* refresh early (540 s). The rule keys on the
180 s open-list TTL, which bounds the gap between open refreshes whether or not
invalidation is happening. Churn model updated (127 → 128 pts/h).

**3. Define max age vs min interval.** *Accepted.* Max age is < 600 s; min interval is
420 s. Both are stated in the criterion and pinned by tests 2–3.

## Claude (REQUEST_CHANGES)

**1. "One process spawn whatever the pages" contradicts paging and the points model.**
*Accepted.* The unit is now **forge calls** (20/h vs 52). `gh` processes are counted
separately: 1 per call, plus 1 per extra page. On codev that is 40/h vs 52 today. Tables
gained a `gh` processes column. Decision 4 and test 20 were restated. The spec records
why `--paginate` is not used: it re-costs the whole query.

**2. 24 h criterion contradicts the cadence.** *Accepted.* Same fix as Codex 1.

**3. Partial GraphQL errors dismissed too quickly.** *Accepted. Option (a) was chosen and
verified.* On gh 2.102.0, a response with one good and one bad field gives exit 1, the
full `{data, errors[].path}` on stdout, and `gh: <msg>` on stderr. The salvage is
therefore implementable from the one response.

New Success Criterion: an error whose paths all lie in window sections, with both open
sections intact, fails only the windows. They get their own failure window and the
output carries `windowsError`. Any other error fails the whole call: a top-level error
(which is what a rate limit is), an open-section error, or a missing open section.

New test 12, two risk rows replacing the old Low coupling row, and the output-shape
definition updated. As the reviewer noted, this is not a runtime fallback: it is honest
partial output from the one call.

**4. "Existing tests pass unchanged" not achievable.** *Accepted.* Test 17 now requires
behaviour parity and lists the fixtures that change because a default GitHub workspace
becomes the bundle path:
- `bugfix-1645-gh-quota.test.ts` counts;
- `overview-rate-limit.test.ts`'s per-concept fake, which gains an `overview-bundle`
  behaviour;
- concept count 20 → 21 in `forge.test.ts` and `doctor.test.ts`.

The four-call behaviour keeps coverage on a fallback-path workspace. The Fallback criterion
now says "behaviour unchanged", not "tests unchanged".

**5. Points measurement lacks the final field set and a contingency.** *Accepted in
part.* The measurements already used the full nested set: `reviewRequests(first:100)`,
`labels(first:100)` and `assignees(first:100)`, and `labels(first:100)` on closed issues.
Scalar fields do not affect cost. The spec now records this explicitly.

Contingency added: the exact final query is re-measured **before** the cache work, and a
miss against the ≤2 / ≤3 ceilings stops the work and goes to the architect. Ride-along's
points saving is what justifies Decision 3, so a miss reopens it.

**Smaller points: all applied.**
- Explicit `CODEV_INCLUDE_WINDOWS=1` replaces reusing `CODEV_SINCE_DATE` presence, whose
  meaning is inverted relative to `recently-merged`.
- Fork / multi-remote base-repo parity added as an assumption with a plan verification
  step.
- `# forge-executable: gh` required in Constraints.
- The doctor projection is labelled "idle steady state".
- New "path selection is cheap" constraint: no resolving all concepts or reading scripts
  per poll.
- Decision 1 notes that a custom `overview-bundle` on a hybrid provider owns every section.
