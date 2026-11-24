# Plan review, iteration 1 — responses

Reviews: codex REQUEST_CHANGES (six points), claude COMMENT (nine points). Every claim about the
source was checked in the file before acting. Fourteen points are applied. One is answered and
partly applied (codex 1). One is applied in a different form from the one asked for (codex 4).

A note on the "working tree changed" warning in both review files: the path that moved was
`codev/state/spir-1940_thread.md`, and I moved it, by appending a log entry while the lanes were
running. Neither reviewer wrote to the tree. The plan itself was not touched while they read it.
I will not write anything to the tree during a review again.

## codex

**1. "Phase 7 cannot be optional."** Partly applied; the rest is answered.

- The reviewer is right that the front-door-only setting is in the approved spec and is a stage 1
  success criterion, and that my wording let phase 7 read as optional by my choice. The executive
  summary now says plainly that the plan builds it and that phase 7 is not optional as the plan
  stands.
- It stays the last phase with nothing depending on it. That is an instruction from the
  architect, not a preference of mine: the owner asked about the opt-in setting after approving
  the spec and has not ruled, the architect recommended cutting it, and I was told to plan it so
  that it can be dropped at plan approval without reworking the rest. Dropping it is a change to
  the approved scope that only the owner can make, and the plan now says that too.
- "Sequence final documentation and end-to-end verification after it" is applied in substance.
  Phase 7 carries its own doc sentences and tests, and its acceptance criteria now rerun the full
  checks of phase 6 with the setting in: unit suites, the end-to-end file, the doc-pair diffs and
  the both-trees grep. I did not move phase 6 after phase 7, because then dropping phase 7 would
  mean rewriting the docs phase, which is the rework the architect asked me to avoid.

**2. `loadConfig` merges layers the spec excludes.** Applied. Verified in
`packages/codev/src/lib/config.ts`: `loadConfig` merges the framework cache, `~/.codev/config.json`,
the project file and `.codev/config.local.json`. Phase 7 now reads the key from the workspace's
committed `.codev/config.json` and nowhere else, with a test per layer that a value elsewhere has
no effect, and a row in the risk table.

**3. `parse(format(a)) = a` cannot hold for reader-relative forms.** Applied. The invariant is now
stated with the reader in it: parse the formatted text, fill the parts it leaves out from the
reader's context by the spec's "Leaving parts out" rule, and the result equals `a`. The reader's
context is defined (`{ owner?, tower?, workspace }`), and the table has a row per tier and reader.

**4. The end-to-end test must run the built `afx send`.** Applied in a different form, and the
contradiction the reviewer found is removed.

- The contradiction was real: the deliverables said `POST /api/send` and the acceptance criterion
  said "the built CLI". Fixed.
- The built binary cannot be pointed at a test Tower. `commands/send.ts` constructs
  `new TowerClient()` with no port, and the client defaults to 4100, which on a developer's machine
  is the live Tower (the guard added for issue #1515 exists because tests once drove it). Adding
  a port override to the CLI for a test's sake is outside this spec.
- So the headline path and the refusals are now driven through the CLI's own `send` command
  function, against a real Tower process, with only the client's port replaced. That exercises
  what the reviewer listed: workspace detection, sender identity, the SDK call, authentication,
  the printed result and the exit status. Commander's argument wiring is the one layer left out.
- The installed binary, typed in a real architect terminal, is the `verify` phase's check, and
  the plan now also says the architect can run it on a branch build before PR approval if the
  owner wants it then.

**5. Six call sites, one of which is a pseudo-sender.** Applied. Phase 4 now separates the five
call sites that carry a message from an agent from the Decisions tab notice, which Tower sends to
`main` of the same workspace. The acceptance criterion is one cross-workspace test for each of the
five, and the sixth asserted unchanged.

**6. The latency baseline procedure is underspecified.** Applied, by the reviewer's first option.
The measurement test is the first thing written in phase 1. It uses only `POST /api/send` against
a Tower started from the build, so the same file runs on today's code and on the finished branch.
The baseline is recorded, with its commit, before the parser is written. Phase 6 reruns it, and if
the result is outside the bound the baseline is retaken from a clean copy of the pre-phase-1
commit before anything is concluded.

## claude

**1. `mailbox-wiring.ts:483` is a missing call site.** Applied; verified. Added to phase 2's file
list, with the note that its sender and target share a workspace by construction.

**2. `send-architect-identity.test.ts` pins `GLOBAL_CURRENT_VERSION = 19`.** Applied; verified at
line 253. Added to phase 3's file list.

**3. `senderWorkspace` can be the literal `unknown`.** Applied; verified at `tower-routes.ts:2345`.
Phase 4 now has an explicit deliverable: an unknown or absent sender workspace keeps today's
frame, with a test for each. Tower does not claim a message came from elsewhere when it does not
know where it came from.

**4. The affinity sentence was right in outcome and ambiguous in mechanism.** Applied. Phase 2
now states the split the reviewer asked for: permission is looked up in the sender's workspace for
every target; affinity applies only when the target workspace is the sender's. The example of a
builder spawned by `review` reaching another workspace's `main`, and never an architect there
called `review`, is in the plan. The change to when the issue #1094 warning fires is recorded as a
deliverable.

**5. The listing was false for a builder caller.** Applied. `GET /api/address-book` takes the
caller's workspace and sender id from phase 5 on, and marks each address with the resolver's own
permission check asked as that caller. An address the caller may not name is still listed, with
the way to reach it. The acceptance test runs as an architect and as a builder. Phase 7 then
changes no wire contract, as the reviewer pointed out.

**6. "Expectations untouched" was too broad.** Applied; verified at `agent-names.test.ts:120-122`.
The criterion now covers the resolution tests by name, says the old parser's unit block is
replaced by the phase 1 table, and records that `a:b:c` moves from a 404 to a 400 on purpose.

**7. Phase 7's config read is uncached and unmeasured.** Applied, together with codex 2. The read
is now one small file, on the cross-workspace named-architect path only, and deliberately not
cached so a change takes effect without restarting Tower. Phase 6 records a cross-workspace
latency figure, and phase 7 records it again with the setting off and on.

**8. "The e2e suite" would run the porch benchmark.** Applied. Phase 6 names the single-file
invocation and says why the whole configuration is not run.

**9. Two naming fixes.** Applied. The skill-hash command is named
(`pnpm --filter @cluesmith/codev generate-skill-hashes`, verified in `package.json`). The shared
table moves to `packages/types/fixtures/address-cases.json`, beside the contract and outside any
one consumer.
