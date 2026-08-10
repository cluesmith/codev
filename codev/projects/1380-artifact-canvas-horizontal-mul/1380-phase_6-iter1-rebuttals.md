# Phase 6 — iteration 1 rebuttals

## Claude (REQUEST_CHANGES)

1. **README column-token paragraph inserted mid-table, orphaning four rows.** Accepted — an
   outright authoring error; the paragraph now sits below the complete color-token table.
2. **Persistence round-trip untested.** Accepted — four new tests drive
   `resolveCustomTextEditor` end-to-end with a fake panel + `Memento`: a valid
   `readingModeChange` reaches `globalState.update` under the stable key, garbage values are
   never stored, the initial HTML seeds from persisted state, and a corrupt persisted value
   seeds nothing. Deleting either provider branch now fails the suite.
3. **Thread log missing phases 5–6.** Accepted — entries added.
4. **FYI: `examples/` outside the package tsconfig.** Noted, pre-existing; the dev-host glue
   is exercised by the Playwright suite. Left as-is (widening the tsconfig is unrelated to
   this phase's scope).

## Codex (REQUEST_CHANGES)

1. **Dev-host mode state "violates no-mode-logic-in-hosts".** Disputed, with the constraint's
   own text: spec Constraint 3 assigns hosts exactly two jobs — a height context and
   persistence — and the dev page's mode state exists to deliver the first. Its vertical
   chrome is a centered 760px well; a well cannot host columns, so the *height context* is
   necessarily mode-dependent in this host. The state holds an opaque string, performs one
   equality check for the page's own chrome, and contains no mode semantics (vocabulary,
   coercion, toggling, and column mechanics all live in the package; the production VS Code
   host carries no such state because its layout is mode-invariant). A code comment now
   records this reasoning at the state declaration. The alternative — a mode-invariant
   full-viewport dev page — would degrade the classic vertical dev experience this page has
   always had, for no reduction in actual coupling.
2. **Persistence-path coverage.** Accepted — same fix as Claude 2.
3. **README table malformed.** Accepted — same fix as Claude 1.

All suites re-verified: 146 canvas jsdom + 30 browser, 751 VS Code unit (4 new), typechecks
clean.
