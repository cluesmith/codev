# Pending owner decisions — all architects (hub: main)

Rule inline: a letter or one word on an item's **Your word:** line is enough. "approve" = approve AND merge.
Newest first. Only main edits this file; architects send items with `afx send architect:main "DECISION …"`.

_Status: 2 open — onboarding-3, main-11. Written 12:20 am (added onboarding-3)._

## Open

### onboarding-3 · 2026-10-17 12:10 am PT · Should the composer get a new scan tool, or reuse the chat tools?

- **Problem:** after onboarding, a user who connects WhatsApp can't run the scan from the composer.
- **Root cause:** the composer does not get the chat tool set.
- **Options:** (a) `newtool` = add a scan tool to the composer (b) `reuse` = give the composer the chat tools
- **Testing:** unit tests for both paths; see https://example.com/pr/42
- **Recommendation (onboarding):** `newtool`. Main's note: smaller blast radius.
- **Links:** https://example.com/pr/42, `src/composer/tools.ts`

- **You asked (6:07 am):** "why a new tool? Don't we have existing tools?"
- **Onboarding's answer (6:09 am):** The Daybreak composer does not get the chat tool set.
  Main checked the code: the tool list is built separately.

**Your word:** `newtool` = add the scan tool / `reuse` = reuse the chat tools / `hold`

### main-11 · 2026-10-16 9:45 pm PT · Merge the retry fix as is?

- **Context:** the retry fix is green; the extra test limit is optional.
- **Recommendation (main):** `accept`.
- **Links:** https://example.com/pr/41

**Your word:** `accept` = merge as is / `rework` = send back / `hold`

## Ruled

- **main-10** · ruled `approve` 11:02 pm · relayed 11:03 pm: merged · DONE 11:20 pm: released
