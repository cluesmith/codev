# Spec 1940 — final review pass: verdicts and what is still open

The second of the two passes the architect asked for, run on the text committed at `23ad14da5`.
Nothing was changed straight after this pass, by instruction.

**Update, later the same day:** on the architect's instruction all eleven numbered points and the
four smaller ones were applied in commit `90ebb0245`, which touches only the spec, so
`git diff 23ad14da5 90ebb0245` reads point by point. No review round followed, also by
instruction: the text at the gate is one step ahead of what the reviewers read. For number 11 the
choice was to serialise relay calls per peer, not to narrow the promise.

| Reviewer | Final verdict |
|---|---|
| codex | REQUEST_CHANGES |
| claude | COMMENT (says three of its points should be fixed before the owner signs) |

## Open — the builder agrees these are real and would fix them

| # | From | What is wrong | The fix, in one line |
|---|---|---|---|
| 1 | claude | Stage 2 says `afx://ana@mbp/…` works on my own Tower, but account handles do not exist until stage 3 | Stage 2 accepts `afx://mbp/…` for self-naming; the form with an owner starts in stage 3 |
| 2 | claude | Mail held at the sender for an offline Tower has no cap. Neither the cloud's limit nor the receiver's applies while the peer is offline, so a looping agent can fill the mailbox unnoticed | Add a cap on mail waiting for one peer, enforced by the sending Tower, refused beyond it |
| 3 | claude | A Tower decides "the cloud has no relay" from whether its tunnel handshake carried a secret. A Tower whose tunnel is merely down would say the same. Sending is plain HTTPS and does not need the secret | Have the cloud state relay support explicitly, and say that sending works while the sender's own tunnel is down |
| 4 | claude | A statement that fails the check right after a tunnel reconnect is a final refusal, so a routine reconnect becomes a hard failure for the sender | Treat that failure as retriable (held at the sender), and name it in the outcome list |
| 5 | claude | `afx workspace name` checks the name against workspaces "Tower knows at that moment". If that means only active ones, an agent can take the basename of a workspace that is not running | Check against every workspace Tower has registered, active or not |
| 6 | codex, claude | `arch`, `architect` and `builder` are reserved as workspace names, yet stage 1 promises every address valid today still resolves. Today `arch` is an alias only in the agent position, so `arch:review` means agent `review` in a workspace called `arch` | Say only the bare word is an alias; a workspace whose basename is a reserved word keeps resolving locally as today and needs an explicit name only to be reached from another Tower |
| 7 | codex | Nothing says what happens when a peer reuses a message id with a different body or recipient | Bind the id to the whole envelope; a mismatch is refused and recorded, not answered with the first row's state |
| 8 | codex | Turning remote messaging off covers mail held at the sender, but not mail already accepted and waiting on a busy agent | Make it the same as removing a grant: it becomes held for release |
| 9 | codex | Limits are called changeable by "the owner of the enforcing side", and `afx peer limits` says they are changed locally; a Tower cannot change the cloud's limits | Separate the cloud's service limits from the Tower's own configurable ones |
| 10 | claude | "Grants store identities" does not fit a front-door grant, which resolves by name when mail arrives; nor is it said what a grant does when its workspace or architect is not registered | State both; also what happens to a grant naming a seat when front-door-only is later turned on |
| 11 | claude | The ordering promise covers all mail from one Tower to one recipient, but the mechanism only orders mail that was held. Two concurrent sends to an online peer are not serialised | Either serialise outbound relay calls per peer, or narrow the promise |

## Open — smaller

- "Stage 1 adds no measurable latency" has no threshold and no method (claude).
- `afx whoami` and `afx workspace name --clear` are in the command table with no criterion or test (claude).
- The forged-header-line guard applies to remote bodies only; applying it to all bodies would make
  one invariant instead of two (claude). No regression as written.
- Two rows of the Compatibility section read as instructions, not constraints (claude).
