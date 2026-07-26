# Rebuttal — `porch_toggle` iteration 2

## Codex: enabled-path phase matrix and persisted state

This was legitimate feedback and is now addressed in
`gate-auto-open.test.ts`.

The enabled cases are the Cartesian product of all three mapped artifact phases
(`specify`, `plan`, and `review`) and both enabled configuration states (unset
and explicit `true`). Every case now asserts:

- the exact `afx open` spawn arguments;
- detached execution and `unref()`;
- truthful opening output; and
- the persisted pending gate with a `requested_at` timestamp.

The focused gate suite passes all 13 tests after the change.
