# secfix-1 — bridge-mode finding for the `pr` gate

Surfaced during pre-merge review of the Tower request-authentication work
(advisory GHSA-xvjp-7748-v88v). Recorded here so the human `pr`-gate reviewer
decides with eyes open. Framed as hardening; no reproduction steps are committed
(a private repro is available on request).

## Finding 1 — the key is not an access control on a non-localhost bind

The shared key fully protects the **default loopback** deployment: a page on
another origin cannot read it (same-origin policy blocks reading the key-bearing
shell, whose CORS header is stripped), so a malicious site cannot drive the API.
That is the advisory's primary threat and it is closed.

Under `BRIDGE_MODE`, however, the `Host` guard deliberately admits IP-literal
peers (a LAN/container client reaches Tower by IP), and the dashboard shell —
served to any admitted peer — carries the injected key so the same-origin client
can call the API. Consequence: **a peer that can load the dashboard can obtain
the key**, so on a non-localhost bind the key does not by itself authenticate
on-network peers. The security boundary there is the **network** (container
isolation / firewall / TLS + trusted peers), exactly as bridge mode was
originally documented ("your firewall is the security boundary", v3.0.2).

The earlier "loopback-gate the key injection" idea was **rejected**: bridge
mode's intended use is container bridging, where the legitimate host peer is
*also* non-loopback, so gating injection on loopback would break the supported
flow rather than fix it.

**Done in this PR:** corrected the `agent-farm.md` bridge section to state the
network is the boundary (no "enforcement keeps on-network peers out" claim).

## Finding 2 — enabling auth is a breaking change for bridge clients

Before this work, bridge mode had no server-side enforcement; clients connected
regardless. With enforcement on, a client reaching a bridged/containerized Tower
must present the key:

- Clients that **share** Tower's `~/.agent-farm/local-key` (same host, or a
  bind-mounted `~/.agent-farm`): unchanged.
- Clients that do **not** share the file (host `afx`/SDK → Tower-in-container, or
  another machine): previously worked, now `401`.

**Done in this PR:** added a `CODEV_TOWER_KEY` env override, authoritative on both
sides (Tower expects it; clients present it), so a client can be given the key
explicitly without sharing the file. Honored uniformly by every key resolver
(core `ensureLocalKey`/`readLocalKey`; the sdk `/node` adapter for VS Code /
Stream Deck). Unit-tested in both packages. Documented in `agent-farm.md` with an
explicit breaking-change callout.

**Needs a release-notes entry (architect):** this is a user-facing breaking
change for bridge deployments — it belongs under **Breaking changes** in the
release notes at changelog time.

## Deferred follow-up (architect to file)

Real per-peer remote authentication for non-localhost Tower (a per-client token
distinct from the shell-injected key, or lean on the Codev Cloud path, which
carries its own auth). Out of scope for secfix-1; `CODEV_TOWER_KEY` is the
interim migration path, not a replacement for it.
