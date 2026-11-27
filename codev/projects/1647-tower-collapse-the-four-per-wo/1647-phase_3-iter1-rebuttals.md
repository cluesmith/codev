# Phase 3, iteration 1: review dispositions

Both lanes: **APPROVE**, confidence HIGH. Codex raised no issues. Claude raised two minor
findings and two notes. Both findings were fixed in place. The notes need no change. Nothing
is rebutted.

| # | Finding (claude) | Disposition |
|---|---|---|
| 1 | `reason: entry.reason` in `cachedFetch`'s suspension arm can only ever be `undefined`. That arm is reached only when the entry has expired or a positive entry was invalidated, and a positive entry never has a reason. | **Fixed.** The arm is back to its original line. This departs from the plan's "copies `entry.reason` … on the suspension path", which would only copy `undefined`. A negative entry with a reason always returns from the within-TTL branch, and the malformed test pins that branch on later polls. |
| 2 | `b.recentlyMerged as ForgePR[] \| null` in `splitBundle` is an unsound cast | **Fixed, with the adjacent four-call typing.** `mergedPRCache` was already typed `ForgePR[]` although `recently-merged` returns `MergedPrItem[]`. The merged section is now `MergedPrItem[]` in both modes, and the cast is gone. Its `url` is optional on that contract, so the issue-to-PR link map now skips a PR without one, where it used to store `undefined`. The JSON payload is the same. New test, in both modes: a merged PR without a `url` links nothing. Removing the guard turns exactly that test red. |
| 3 | Note: a `null` section during a suspension caused elsewhere reports the rate-limit text, not `overview-bundle returned no …` | No change. The plan orders the two new `describeMissing` cases after the rate-limit and disabled checks, matching four-call precedence. |
| 4 | Note: `codev status` also drives `OverviewCache`, so it picks up bundle mode too | No change. It is the overview cache, the one consumer the spec moves to the bundle. |

After the fixes: typecheck clean; the seven overview test files (293 tests) pass.
