# Spec 1307 — Rebuttals, Specify iteration 1

Both reviewers returned `REQUEST_CHANGES`. **I accepted all fourteen findings.** There
are no disagreements to defend — but "accepted" is doing different work in different
places, so each entry says what actually changed and, where a finding invalidated
something I had asserted, says so plainly.

Sequencing note: Codex's lane was down when Claude reviewed (vendored `@openai/codex-sdk`
binary rejected for `gpt-5.6-sol`; PR #1309 bumped it). Per architect ruling, Codex
reviewed the *revised* spec. That worked in the spec's favour — its findings are all
distinct from Claude's, and several are consequences of the redesign Claude prompted.

---

## Claude (REQUEST_CHANGES, HIGH confidence)

### C1. Post-clear "stop stale monitors" is unimplementable as written

**Accepted — the criterion was wishful.** I required the *resumed* instance to stop
monitors that survived the clear, but issue comment 2 says these are harness background
tasks that `pgrep` cannot see, and the fresh context has no handles for them. I had
written an acceptance criterion and a test for something no one could implement.

**Changed**: split into the enforceable half and the best-effort half. The **pre-clear**
architect stops its own monitors — it is the only party holding the handles — and the
skill sequences that before the state write. The resumed instance's obligation is
reconciliation: treat any alert it cannot account for from the state block as stale, and
disregard rather than act on it. Success criteria and Test 18 rewritten. Whether a
harness task-listing surface exists is now an open question that the spec deliberately
does *not* depend on.

### C2. The `## Monitors` gate contradicts the template it validates

**Accepted, and this one was self-inflicted twice over**: I mandated a machine-checked
`## Monitors` heading while simultaneously listing its placement as an *unresolved* open
question, against a template (v67) that carries the list as numbered lines inside a
`#`-comment intent stamp. The shipped validator would have rejected the shipped template.

**Changed**: the gate is now a literal `MONITORS:` token that the template carries
verbatim, checkable without constraining the block's shape. Placement question closed
rather than left open under a mandate.

### C3. No protection against a new turn between receipt and clear

**Accepted.** Absent from risks, questions and tests. See Codex X2 — its follow-up showed
my first fix still overclaimed, and the final position is a *bounded window*, not a
guarantee.

### C4. `--boundary` overclaimed as a recorded human decision

**Accepted.** In the self path the agent types the flag; nothing about it establishes
human provenance. **Changed**: Security now states what it does and does not prove, and
the audit record captures **invocation mode** (self vs external) so a reader can tell
which kind of cycle they are looking at.

### C5. The unrun 1273 e2e leaves quiescence unvalidated too, not just `/clear`

**Accepted.** I had elevated the `/clear` question to Critical and missed that the same
unrun test leaves quiescence-against-a-live-TUI equally unknown. **Changed**: added as a
second Critical open question, with its distinguishing property called out — the failure
is *safe but total* (if an idle TUI repaints, every run aborts and the feature never
works). The live run is now scoped to both.

### C6. Raw-injecting a slash command with an argument; `sendMessage` vs `sendRaw`

**Accepted.** **Changed** twice, and the second change matters: I first adopted
plain-text injection as settled. The owner then directed that the delivery mechanism be
carried as an **explicitly open decision** — correctly, since I had settled it twice in
opposite directions on reasoning alone. It is now a named decision with three candidates
(raw-typed, plain-text, 1273's file+inline shape), to be resolved empirically against a
real terminal with the reason recorded. The channel-distinctness constraint survives
independently.

### C7. Write-then-verify was not considered

**Accepted, and it changed the recommendation.** This was the most valuable finding in
either review. Having the architect write the state file *before* invoking the CLI lets
the CLI validate synchronously and arm only `quiesce → clear → reorient`. It removes
receipt polling from Tower, makes "no clear without a verified save" true **by
construction** in the self path, and shrinks the post-save-work window from minutes to a
quiet window. Now Approach 1; the original nonce/Tower-armed design is retained as
Approach 1b with its rejection reasons rather than deleted.

**Self-caught consequence**: write-then-verify breaks the state-file snapshot, since the
CLI no longer runs before the overwrite. Flagged as its own risk — and Codex then showed
my first fix for it was inadequate (X3).

### C8. Scope note (not a defect)

**Accepted as guidance.** Added a Notes paragraph telling the plan to phase this honestly
rather than compress it.

---

## Codex (REQUEST_CHANGES, HIGH confidence)

Two of Codex's findings were factual claims about the codebase. I verified both against
the source before acting, per the standing lesson that reviewer claims are evidence and
not ground truth. **Both were correct, and both invalidated a premise of mine.**

### X1. The Tower scheduling premise is wrong — VERIFIED

**Accepted.** I claimed the armed job could ride "an existing Tower tick." Checked
`packages/codev/src/agent-farm/servers/tower-cron.ts:70`: the interval is **60 seconds**,
over filesystem-backed cron definitions. It is not a generic job runner, and 60s is two
orders of magnitude too coarse to observe a 1.5s quiet window.

**Changed**: the clear-job runs its own bounded poll loop started at arm time, at the
reset poll interval; Performance's resource model corrected; the erroneous claim
explicitly retracted in the spec text so the next reader does not re-derive it.

### X2. The post-save-work guarantee is not implementable from `lastDataAt` — VERIFIED

**Accepted, and this is the most important correction in the round.** Checked
`packages/codev/src/terminal/shellper-client.ts`: `lastDataAt` is a last-output
timestamp. Tower exposes no turn identifier, no input-generation counter, no handoff
token. Therefore "the original turn ended" and "a follow-up turn ended" are
**observationally identical**, and my criterion — "the clear can never destroy work
created after the verified save" — could not be implemented or tested. Notably this
survived *my own* fix for C3: I closed the hazard with a mechanism that cannot observe
what it needs to observe.

**Changed**: downgraded from guarantee to **bounded window**, stated as such. What
remains enforceable: fire on the first quiescence transition after arming, cap the armed
lifetime, and refuse if the terminal's output total has grown beyond tolerance since
arming — the last being an explicit *heuristic* (it catches a full follow-up turn, not a
one-line exchange) and labelled as one everywhere it appears. Adding a proper Tower
observable is raised as an open question rather than quietly pulled into scope.

### X3. The self-path snapshot is not machine-gated

**Accepted.** The skill took the snapshot before the CLI started, so nothing verified it
existed or predated the new file — while Security claimed a clear was unreachable without
it. A guarantee resting on a convention.

**Changed — this produced a real design improvement.** Introduced a `--begin` /
`--boundary` handshake: `--begin` takes the snapshot under machine control and issues a
one-time token; `--boundary` requires the state file to carry it. Missing or stale token
is refused. This closes the snapshot hole **and** restores a machine-proven freshness
token to the self path — which the previous draft had traded away on the argument that
self-attestation was equivalent. It was not, precisely because it left the snapshot
ordering unproven.

### X4. Cancellation, status and dropped-job reporting have no specified surface

**Accepted, including the contradiction underneath it**: I required that a job dropped by
a Tower restart be "reported rather than silent" while also specifying purely in-memory
jobs. A purely in-memory job that dies with Tower leaves nothing to report.

**Changed**: split execution from intent. The **running job** stays in memory, preserving
the fail-safe restart property (a dropped job can never clear). A small **durable intent
record** is written at arm time and removed on completion or cancellation, so a leftover
record is unambiguous evidence of an unfinished cycle. Status and cancel are specified as
user-visible surfaces; tests 15e/15f added.

### X5. The self-invocation flow contradicts itself

**Accepted.** Test 2 still described the CLI returning "the nonce and instructions"
*before* the write — a leftover from the superseded design that survived the redesign
because I revised the prose and did not re-read the tests against it.

**Changed**: Test 2 rewritten to the `--begin` → write → `--boundary` sequence, with a
parenthetical recording what it used to say and why that was wrong. Tests 4 and 5 scoped
to the external path, since the self path has no receipt wait. Tests 2a/2b added for the
missing- and stale-token cases.

### X6. Compaction validation needs exact rules

**Accepted.** "Growth comparison" and "one-screen order of magnitude" are not testable
boundaries.

**Changed**: exact predicate — reject if the `--begin` snapshot survives in the new file
as an **unmodified leading section** (trailing whitespace normalised). Genuine compaction
always edits content above the new entry, so a byte-identical prefix is precisely the
append-only signature. Chosen over a size ratio deliberately: it admits the
compact-and-grow case (old material collapsed to pointers, substantial new material
added, net larger) that a ratio rule would wrongly reject — now Test 15c. Behaviour with
no predecessor defined: check skipped, not failed (Test 15d), or no architect could ever
write a first save. Size ceiling kept as an independent bound, with its value an open
question to be derived from real state files rather than guessed.

### X7. Failure guarantees are overstated

**Accepted.** "Every gate that fails … leaves … a saved state file" is false for
missing-boundary, invalid-name, Tower-down, missing-file, and external receipt-timeout
failures — in several of those, the save is exactly what did not happen.

**Changed**: split into preflight failures (nothing touched; no fresh state file implied)
and post-verification aborts (context intact **and** a verified state file on disk), with
the universally-true guarantee stated narrowly: **no failure path clears context.**

---

## Summary of changes

| Finding | Disposition | Substance of the change |
|---|---|---|
| C1 monitor enumeration | Accepted | Pre-clear stop enforceable; post-clear best-effort |
| C2 `## Monitors` contradiction | Accepted | `MONITORS:` token; open question closed |
| C3 turn-after-save hazard | Accepted | Added; then corrected by X2 |
| C4 `--boundary` overclaim | Accepted | Records invocation mode; states the limit |
| C5 quiescence unvalidated | Accepted | Second Critical question; safe-but-total |
| C6 slash-command delivery | Accepted | Now an explicitly open decision, 3 candidates |
| C7 write-then-verify | Accepted | **Changed the recommended approach** |
| C8 scope note | Accepted | Phasing guidance for the plan |
| X1 Tower tick (verified) | Accepted | Own bounded loop; wrong claim retracted |
| X2 turn observability (verified) | Accepted | **Guarantee → bounded window** |
| X3 snapshot not gated | Accepted | **`--begin`/`--boundary` handshake** |
| X4 status/cancel/reporting | Accepted | In-memory execution + durable intent record |
| X5 flow contradiction | Accepted | Test 2 rewritten; tests scoped by path |
| X6 compaction rules | Accepted | Exact prefix predicate; no-predecessor case |
| X7 overstated guarantees | Accepted | Preflight vs post-verification split |

Also incorporated this round, from the owner via the architect: **pruning is a
requirement, not guidance** (a save that only appends fails — X6's predicate is how that
is enforced), and **the re-orientation delivery mechanism is explicitly undecided**
(C6's final disposition).

Commits: `4150edb7` (Claude round), `1f11f794` (delivery-mechanism iteration),
`de043dfd` (owner directives), `93bd2a9d` (Codex round).
