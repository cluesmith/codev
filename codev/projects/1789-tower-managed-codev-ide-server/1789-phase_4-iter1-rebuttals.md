# Phase 4, iteration 1: response to review

Gemini was skipped (agy produced no output). Codex and Claude both requested changes for the same defect. All points are accepted and fixed in `25808d453`.

## Blocking: `restartRequired` missed an already-stale sidebar (Codex, Claude)

Agreed. The adopt path used only this start's install outcome (`sidebarChanged`), so a second start after an unrestarted sidebar upgrade skipped the install and reported `restartRequired: false`, while the live server still ran the old sidebar. The same false negative followed a Tower restart.

Changed: `adoptLiveIdeServer` now calls `liveServerIsCurrent(prior, preflight)`, which compares the record's `sidebarVersion` and `extensionsDir` with what this preflight prepared. Because the adopted record deliberately keeps what the live process loaded, every later start keeps reporting a restart until the server is restarted. A missing embedded vsix (`sidebarVersion` null) is not treated as stale. The `restartRequired` docstring is updated to match.

Tests: the shared fixture now seeds a genuinely current record (`sidebarVersion: '3.3.4'`), so the "current server needs no restart" case no longer encodes the gap. New cases: repeated starts after an install (both report `true`, record keeps `3.3.0`, server not killed); missing embedded vsix against a current server (`false`).

## Minor: `extensionsDir` mismatch not treated as stale (Claude)

Agreed and folded into the same check: any difference from the current extensions directory, not only an absent one, requires a restart. New test covers it.

## Minor: `defaultFolder` on adopt dropped the prior value (Claude)

Agreed: adopt now records `opts.defaultFolder ?? prior.defaultFolder`, so a start without `--default-folder` keeps the live server's recorded folder, and a start that names one still replaces it (that value drives the next respawn). New test covers both.

Result: `ide-server-preflight.test.ts` 27/27, `tsc` clean.
