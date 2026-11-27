# Phase 7, iteration 1: response to review

codex asked for changes (HIGH confidence). claude approved (HIGH), with four non-blocking
notes. codex's point is taken and fixed, as are claude's notes 1 and 3. Notes 2 and 4 are
answered below. Nothing is disputed.

## codex: peer state is not scoped to the active cloud registration

**Taken.** After this Tower registers again under another account, another Tower id or another
cloud, three things were still the previous registration's:

- the cached listing and its former names, on disk;
- the relay evidence, in memory;
- the listing's call budget.

So `afx peer list` could show the previous account's Towers, and the grant routes could resolve
a name against them. Neither spec says what a registration change does to the peer list. But a
list fetched for one registration is not another's, so I treated this as a defect, not a choice.
The cloud's same-account rule still refuses any relay across accounts, so nothing could cross
accounts. The Tower was showing and resolving the wrong list.

Changed:

- **The scope.** `peer_settings.listing_scope` (added to v21, which no shipped build has run)
  records the registration a listing was fetched under: the cloud's server URL, trailing slashes
  stripped, and this Tower's id (`listingScope` in `peer/peer-list.ts`). The API key is not part
  of it. A new key for the same Tower on the same cloud, as `afx tower connect --reauth` gives,
  keeps the list.
- **The store.** `writeListing` takes the scope (`fetchedFor`, required). A listing for another
  scope starts the former names afresh. `forgetListingUnlessFor(db, scope)` drops the Towers, the
  former names and the listing's fields in one transaction, unless they are the scope's. Grants
  are a human's decision and stay, as does the switch.
- **`PeerList`.** Every read goes through `scoped()` first: `relay`, `relayStated`, `cached`,
  `refresh`, `resolve` and `noteAuthOk`. It drops what was fetched or noted under another
  registration, and logs INFO once when it drops a list. With no registration nothing is
  dropped, since nothing can be sent until there is one. The check after the call (iteration 0's
  late fix) now also drops the previous registration's list.
- **The routes.** Every peer request calls `scopeToRegistration()` before its handler, so the
  grant routes and `GET /api/peer/limits`, which read the cache directly, never see another
  registration's list.
- **The budget.** The cloud client counts the listing budget per registration (origin and key).

Tests:

- `peer-list.test.ts`:
  - **codex's case:** cache account A with its relay noted available, then register as account
    B on a cloud that refuses. The list is empty and the former names are gone. The relay is
    `unknown` and not stated. `devvm` is refused as never listed, with the cloud unreachable.
  - The same Tower on the same cloud keeps its list, whatever its key and however its URL ends.
  - A change of cloud alone drops the list. The new cloud's budget is its own: it is called
    within 10 s of the old one's call.
  - A registration change during a call drops the previous list, and keeps nothing.
- `peer-routes-wiring.test.ts`, through the production wiring. A list cached under another
  registration shows no Towers and no cloud limits. A grant naming one of its Towers is refused
  `UNKNOWN_TOWER`, and the existing grant stays.
- `peer-storage-migration.test.ts`: `forgetListingUnlessFor` and the fresh start of the former
  names, with grants and switch left alone.
- The self-check test now uses a client that answers another Tower's list under an unchanged
  registration, so the cached list standing is still what it proves.

## claude, note 1: `relayStated()` reads every Tower row

**Taken.** `relayStated()` and `relay()` now read `readListingRelay`: the settings row only, no
Tower rows. `readListing` builds its result from the same row reader.

## claude, note 2: a malformed `server_url` gives a 500

**Not changed.** A `server_url` that is not a URL is a broken `cloud-config.json`, which Tower
never writes. The route fails loudly: a 500 whose log line names the cause ("cloud-config.json's
server_url is not a URL"), as the project's fail-fast rule asks. Reporting it as "no relay"
would hide the real fault behind a true-sounding state. `afx peer limits`, `afx peer grants` and
the switch keep working, as claude notes.

## claude, note 3: two wordings

**Taken.** `hasPendingSwitchReport()` now says it is true while a call is in flight as well as
while a retry waits. The test is renamed "makes one call at a time, and after one in flight
sends only the newest change, not each one in between".

## claude, note 4: `retryable` on an over-cap listing is never read

**Not changed.** No listing call reads `retryable`: the listing has no retry loop, only its call
budget. It is filled in for every failure so the two route classifiers return one shape, and the
value is right for the case. Phase 8's holding loop may read it.
