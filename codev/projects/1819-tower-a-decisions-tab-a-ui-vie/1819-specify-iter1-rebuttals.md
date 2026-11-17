# Spec 1819 — iteration 1 rebuttal

Both reviewers requested changes. Every point was accepted and the spec revised (commit
`ee3b02c3f`). No point is disputed.

## Codex (REQUEST_CHANGES)

1. **Symlink containment.** Accepted. "Configuration" now requires the path to be resolved and
   canonicalized (symlinks followed) at every read and write, refusing anything whose canonical
   location is outside the canonical workspace root. Symlink policy: a symlink to an in-workspace
   target is allowed; the atomic write replaces the target and leaves the link. Route test added
   for an in-workspace symlink pointing outside.
2. **Comment validation incomplete (fences, indented headings, `**Your word:**` in fences).**
   Accepted. Added a "Structural grammar" section (CommonMark subset: fence lines with ≤3 spaces
   and length-matched closing, ATX headings with ≤3 leading spaces, Your-word lines only when
   unfenced). Comments containing a heading line, a fence line, or a Your-word line are refused,
   and every splice is re-parsed and verified (same sections, same items/ids/order, same options,
   current ruling equals exactly the inserted text) as a catch-all. Splice tests added for each.
3. **Duplicate ids vs drafts keyed by id.** Accepted. Duplicate-id items are entirely read-only
   (no option buttons, no comment box, no draft). A draft whose id becomes duplicated is "held"
   (read-only, copyable, Discard).
4. **Timestamp under-specification.** Accepted. The abbreviation table is enumerated (generic NA
   zones via IANA; fixed-offset abbreviations listed; `IST`/`BST`/`AST` explicitly excluded;
   `CST` documented as North-American Central). DST gap and fold times in IANA/generic zones are
   shown verbatim as unconverted, no tie-break. Tests added for a gap, a fold and every table entry.

## Claude (REQUEST_CHANGES)

1. **No serialization / atomic write.** Accepted. Writes are serialized per file inside Tower and
   re-read after taking their turn; the file is replaced via temp file + rename in the target's
   directory, keeping permissions. Combined with item 3 below, the second of two concurrent
   submits is refused as already ruled — a success criterion and route test now cover it.
2. **"Same bytes as hand-typed" untestable; blank-line assumption unverifiable.** Accepted. The
   criterion is replaced by "inserts exactly the bytes defined in Writing, unit-tested
   byte-for-byte". The blank line between the `**Your word:**` line and the word is dropped (the
   word goes on the very next line, the most literal reading of the issue), and `main`'s scan
   contract is now Critical Open Question 1 for the architect to confirm at the gate.
3. **Re-ruling leaves two words.** Accepted; position reversed. An item with a current ruling is
   now read-only in the tab; a change of mind goes through `main` or a hand edit. The file never
   carries two tab-written rulings.
4. **Unclosed fence in a comment.** Accepted — covered by the fence-line refusal and the re-parse
   verification (codex point 2).
5. **Write success response unspecified.** Accepted. A successful write returns the re-parsed
   document with new fingerprints; the tab renders it at once.
6. **Timestamp cost understated.** Accepted. The spec now states resolution uses `Intl` offset
   probing on the server with no new dependency, and names the cost in Approach 1's cons.
7. **Links navigate the SPA away.** Accepted. The Decisions view handles clicks in its own
   container: `http(s)` opens in a new tab with `noopener`, other links are inert. The shared
   renderer (also used by VS Code) is unchanged.

Minor points, also accepted: a 10,000-character comment limit; realpath containment (codex 1);
letters — the spec notes the tab offers and writes the option word, letters being a hand-typing
shorthand.
