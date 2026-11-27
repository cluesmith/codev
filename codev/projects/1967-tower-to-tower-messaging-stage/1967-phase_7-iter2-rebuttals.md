# Phase 7, iteration 2: response to review

codex asked for changes (HIGH confidence). claude approved (HIGH), with four non-blocking
notes. codex's point is taken and fixed. It is also claude's note 1. Claude's notes 2 and 3 are
taken too. Note 4 is answered below. Nothing is disputed.

## codex: an in-flight listing can fill a new cloud registration with the old cloud's peers

**Taken.** Two gaps let an answer cross from one registration to the next:

- **The shared call.** `CloudClient.listTowers` shared a call in flight with any caller,
  whatever the registration.
- **The check after the call.** `PeerList.refresh` checked only `self.towerId` once the call
  returned.

So if the cloud changed while a call was out, and the Tower id stayed the same, the old cloud's
list was written under the new cloud's scope.

Changed:

- **The shared call.** A call in flight is shared only with callers under the same
  registration: the route URL and the key. A call made under another registration starts its
  own. When the first call settles, it no longer clears the second's place.
- **The check after the call.** `refresh` records `listingScope(registration)` before the call
  and compares it with the scope read once the call returns. The check now comes before the
  answer is read at all, so a failure under the old registration notes nothing against the new
  one. Before, an old cloud's bodyless 404 would have been taken as "no relay" for the new
  registration.
- **What a changed registration returns.** The answer is not used, and `refresh` reports a new
  problem, `registration-changed`, not `bad-listing`. The cloud's list was not malformed, and
  saying so would send the human to the wrong log line.
  - The CLI says: "This Tower's Codev Cloud registration changed while its peer list was
    fetched. List again: afx peer list".
  - A send's refusal names it among the reasons the list is stale.
  - The `self.towerId` check stays for its own case: a cloud that answers with another Tower's
    list under an unchanged registration.

Tests:

- `peer-list.test.ts`:
  - **codex's case.** A second stand-in has a Tower with the same id and key. The cloud
    changes while the first call is out. The answer is `registration-changed`, nothing is
    cached and no former name is kept. The next refresh is the second cloud's own (`studio`),
    within its own budget.
  - A failure under the previous registration (the old cloud's bodyless 404) leaves the new
    one's relay `unknown`.
  - The Tower-id change during a call now expects `registration-changed` and its INFO line.
- `peer-cloud-client.test.ts`: two callers under one registration share a call, and a third
  under another gets its own. Each gets its own answer.
- `peer-cloud-wiring.test.ts`: the registration written for another Tower during a call is now
  `registration-changed`, and the config is untouched as before.

## claude, note 1: the check after the call compares only `self.towerId`

**Taken.** This is codex's point above: the full scope is compared now.

## claude, note 2: with no registration, the previous list is still shown

**Taken, as a decision.** With no registration, nothing is dropped. A Tower reconnected to the
same account finds its former names again, and nothing can be sent until it has a
registration. The display no longer leaves that implicit. With the cloud not connected, or the
registration removed, the note now says the Towers shown are from its last list, and when:
"This Tower is not connected to Codev Cloud; the Towers above are from its last list, at
<time>. Connect it with: afx tower connect". The next registration under another scope drops
the list before anything reads it.

## claude, note 3: `scoped()` writes on every read

**Taken.** `forgetListingUnlessFor` now reads the one settings row first. When the scope is this
registration's, or there is none, it returns with no transaction and no write statement. Only
a scope that differs opens the transaction. This relies on an invariant stated in its doc: a
cached Tower or name exists only with a scope. `writeListing` sets the scope, and the drop
clears all three together.

## claude, note 4: `problemOf`'s throw for `malformed` is unreachable

**Not changed.** By design it is reachable only if the cloud answers the listing in a way the
contract does not allow, and then the fail-fast rule wants it loud.
