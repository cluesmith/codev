# Phase 1 review, iteration 1 — responses

Reviews: codex REQUEST_CHANGES (one point), claude APPROVE (six observations, none blocking).
Nothing is rebutted. The tree was not touched while the lanes ran.

## codex

**Owner handles may start with a digit.** Applied. The reviewer is right: spec Decision 2 defines
a handle as "lower-case letters, digits and hyphens, starting with a letter", and the parser used
the Tower-name rule for both. `packages/sdk/src/address.ts` now has a separate `OWNER_PATTERN`
(`^[a-z][a-z0-9-]*$`); Tower names keep `^[a-z0-9][a-z0-9-]*$`. The shared table gained three
rows: a digit-leading owner and a hyphen-leading owner are malformed, and a handle with digits
and hyphens after its first letter is valid. The error text now says the handle must start with a
letter.

## claude

1. **A mistyped scheme parsed as a valid local address.** Applied. `afx:/tower/…` and
   `afx//tower/…` are now refused with a new code, `REMOTE_BAD_SCHEME`, a message that names
   `afx://`, and the remote shape as the expected one. The check is narrow on purpose: it fires
   only when the text begins `afx:/` or `afx//`. `afx:architect` and `afx:builder-spir-1` stay
   valid local addresses, because a workspace may be called `afx`; both are pinned in the table.
   No address that could resolve before is affected: read as local, the caught forms named a
   workspace or an id containing a slash, which nothing can have.
2. **Owner handle starting with a digit.** Applied; same change as codex's point.
3. **`isAddressComponent` rejects mixed case, so phase 3 must lower-case before validating.**
   Agreed and recorded in the thread log as a note for phase 3. No change in this phase: the
   function is right for input that is already lower-cased, and `afx workspace name` does not
   exist yet.
4. **`formatAddress` throws, and phase 4 calls it on a message path.** Agreed and recorded as a
   note for phase 4: the name is checked before formatting, and the throw must not be able to
   surface as a 500 on `/api/send`. No change in this phase.
5. **`afx://a:b@devvm/…` reports `INVALID_COMPONENT` on the owner, not `REMOTE_PORT`.** Left as it
   is. The colon there is in the owner part, so it is not a port; "owner may contain only
   letters, digits and hyphens" is the accurate reason.
6. **The `expected` assertion did not tell the two tiers apart.** Applied. The malformed-row test
   now asserts the remote shape exactly when the text was, or was meant to be, a remote address,
   and the local shape otherwise.

## Checks after the changes

`codev-types` and `codev-sdk` rebuilt. SDK suite 363 passed. The shared table (98 parse rows, 18
format rows) passes in `packages/codev` and `apps/vscode` through their own imports, 117 tests
each.
