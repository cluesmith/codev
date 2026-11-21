# Spec 1940 — responses to the second review round

This round was run by hand at the architect's request, after the owner sent the spec back from the
gate and it was revised (owner in the address, invitation walkthrough, command surface). Porch was
parked at `spec-approval` and hands out no further consultation there. Both lanes used the command
shape porch used in round 1. Nothing in the tree was edited while either lane was running.

Two findings are rebutted with evidence. Everything else was accepted and applied.

## Rebutted

| Reviewer | Claim | Why it does not hold |
|---|---|---|
| claude | The spec reverses the owner's priority order (own Towers, other owners, then architects) and labels the reversal as the owner's | The reviewer read `.builder-prompt.txt`, which holds the issue as first filed. The owner changed the order on the issue on 2026-11-21T01:35:38Z (architects first, "must not wait behind the other two"), relayed to the builder by the architect the same minute. The spec follows the current issue. Changed anyway: the Problem Statement now says which version of the issue the order comes from, so the next reader does not trip on the same stale file. |
| claude | "Messages are capped at 48 KB" is false; 48 KB is only the `--file` cap and the real bound is the 1 MiB request body | `MAX_MESSAGE_BYTES = 48 * 1024` (`utils/message-format.ts:120`) is enforced on the message itself in the CLI (`commands/send.ts:384`, `messageLimitError(message)`) and again in Tower (`servers/tower-routes.ts:2272`, `bodyLength > MAX_MESSAGE_BYTES` → `MESSAGE_TOO_LARGE`). `MAX_FILE_SIZE` is defined as that same constant. The limits table stands. The Current State sentence now says where the cap is enforced. |

## Accepted — claude

| Point | Change |
|---|---|
| The frame constraint ignored the four-line threshold | Verified (`isLongFrame`: 4+ lines or over 256 bytes; the footer comment in `message-format.ts` calls the three-line frame load-bearing). The constraint is rewritten: every frame stays three lines with the reply command on the footer line; the byte limit is unchanged, with the body budget stated (about 90 bytes cross-workspace, about 30 from another owner's Tower); longer frames take the paste path. Decision 7 and the test scenario now match. |
| Remote header presents peer-asserted fields as authenticated | Decision 7 gains a bullet: owner and Tower are authenticated by the cloud; workspace and agent are the sending Tower's claim. The role guidance says the same. |
| Absolute backward-compat criterion vs the new charset | The component rule now governs explicit names and `afx://` addresses only. A local address matches a basename as today, whatever its characters. Test added. |
| "Never expiring" vs the 30-day refusal; the deadline depended on the receiver's setting | A message has a fixed 30-day lifetime set by the protocol. The sender marks its own row expired; the receiver refuses past it and keeps its dedup record at least that long regardless of its retention setting. Open Question 7, the criterion and the limits table agree. |
| `/t/` proxy exclusion is enforceable only in the cloud | Decision 3 says which party enforces which half; the criterion and test are split the same way. |
| Ordering consequences | Stated: the queue is per peer; a refused message leaves the order. |
| `--all` has no address | Reworded: it stays local-only. |
| Dev terminals | One clause: not recipients today, not made so. |
| Length; command table may go stale | Not changed. The owner asked for the command surface in the spec. Names are now "proposed", changeable by the plan only on a collision. |

## Accepted — codex

| Point | Change |
|---|---|
| Critical questions and scope unresolved | They are the owner's and are decided at the gate, which is where the spec is. Open Questions now opens by saying the spec is written under each recommended answer and that approval adopts them unless the owner rules otherwise. The intro no longer defers address and command spellings to the plan. |
| "Exactly once" overstated | Renamed "accepted once" and scoped: one mailbox row per message. Typing the row into the terminal has Spec 1313's guarantee and no more. |
| Sender-held retention contradictory | Fixed with the 30-day protocol lifetime above. A sender-held row ends as accepted, refused, dismissed or expired. |
| Workspace-name collision rules conflict | Split by order of events: a name cannot be set if any other workspace is using it; a workspace that arrives later with a clashing basename does not take the name and is reported as needing its own. Tests added. |
| No mixed-version behaviour | New "Mixed versions" paragraph in Decision 3: protocol version on every relayed message, refusal (not hold) for an unsupported version, an old peer, or a cloud with no relay; Tower keeps accepting string addresses from clients. Criterion and tests added. |
