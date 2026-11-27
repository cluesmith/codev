# Phase 13, iteration 1: responses to review

Codex approved with high confidence and raised no issues. Claude also approved with high confidence and made six non-blocking comments:

- Three are fixed in this phase: 1, the first half of 2, and 3.
- One goes to the architect for the PR gate: the second half of 2.
- One the architect has already ruled on: 4.
- Two need no change: 5 and 6.

## 1. Gap 11 contradicts the verify-approval list: fixed

Agreed. The real-cloud item ("what the real Codev Cloud stores of a relayed message: no body") was added to the verify-approval list after the table was drafted. Gap 11 now says the cloud half is on that list.

## 2. Two gaps that are explicit spec criteria

- **Gap 1: a fresh send refused for rate exits non-zero. Fixed.** `peer-send-cli.test.ts`'s `prints a refusal by %s (%s) in its own words, and exits non-zero` has two new rows: `['peer', 'rate-limited', …]` and `['cloud', 'rate-limited', …]`. Each message is the one the sending Tower writes (`peerRefusalMessage` and `cloudRefusalMessage` in `peer/sender.ts`, with `retryIn`). Result: 21/21. Gap 1 in the review is marked closed, and the scenario row names the new rows.
- **Gap 2: the builder-footer reply round trip. For the architect, at the PR gate.** Closing it means a builder session on the receiving Tower of a two-Tower test, messaged under `--all`, sending its footer's command back. That is a new layer B case in an earlier phase's file, not a row. The reviewer suggests raising it at the gate, and I have named it to the architect.

## 3. The phase 10 ruling is in no doc: fixed

Agreed, and it is within phase 13's remit. The `afx peer show` row in `agent-farm.md`, in both trees, now says that only workspaces running there are listed. A stopped workspace is not listed, because a message cannot reach it until it starts. An agent of a running workspace with no live terminal is `not live`, and mail for it is held there. The skill's own line already reads "What runs on <tower>…", which is accurate, so the skill and its hashes are unchanged.

## 4. The template-pair criterion was adapted: already ruled

The architect confirmed this reading at 2026-11-27T13:35Z. Each pair keeps the two hunks by which it differs on main by design (the title line and the AGENTS.md note), and every edit is identical in both. It is also recorded in the thread.

## 5. The two pipeline timeouts are redundant: no change

They are not redundant. A test's own timeout argument overrides the file's configured default:

- `vi.setConfig({ testTimeout })` on Windows covers the eleven tests that give no timeout.
- `TEST_TIMEOUT` covers the four that give one. Those four need an explicit value on POSIX as well, because vitest's POSIX default is 5 s.

Dropping either would leave some tests on Windows at 30 s.

## 6. The held line's full UUID against the spec's `7c1e52aa`: no change

Agreed that the spec's id is illustrative. The walkthrough asserts the full id the command prints.
