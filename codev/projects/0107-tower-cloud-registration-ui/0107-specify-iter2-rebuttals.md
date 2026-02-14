# Iteration 2 Rebuttals

## Disputed: Origin needs strict allowlisting/validation to prevent open-redirect/callback poisoning

The spec already addresses this explicitly in the Constraints section (line 167):

> The `origin` is not a security boundary — nonce validation provides security. Origin is validated as a well-formed URL but not allowlisted (Tower is a local-first tool accessed from trusted networks).

Tower is accessed from localhost or trusted LAN networks. The `origin` parameter is used solely to construct the callback URL so the OAuth redirect lands back at the correct address (e.g., `192.168.1.5:4100` instead of `localhost:4100`). Security is provided by the nonce — even if an attacker crafted a malicious origin, the callback requires a valid, single-use, time-limited nonce to complete registration. No credentials are leaked to the origin URL; the token exchange happens server-to-server (Tower → codevos.ai). Allowlisting origins would break legitimate LAN access patterns without adding meaningful security.

## Disputed: Smart connect "valid" is undefined

The spec already defines exact validation criteria in the Smart Connect section (line 59):

> if `readCloudConfig()` returns a non-null config (all 4 required fields present as non-empty strings: `tower_id`, `tower_name`, `api_key`, `server_url`), POST `/api/tunnel/connect` with no body reconnects the existing tunnel. If the config file is missing, `readCloudConfig()` returns null and the full OAuth flow starts. If the config file exists but is malformed (invalid JSON or missing fields), `readCloudConfig()` returns null and the OAuth flow starts (the existing validation in `cloud-config.ts` handles this).

This covers: what fields must be present, what types they must be, what happens when the file is missing, and what happens when it's malformed. The existing `readCloudConfig()` in `cloud-config.ts` already implements this validation.

## Disputed: Concurrent connect attempts are under-specified

The spec already addresses this in the OAuth State Management section (line 103):

> Multiple connect initiations are allowed (each gets its own nonce). The first callback to complete wins and writes the config. Subsequent callbacks with valid nonces will also succeed — last writer wins. This is acceptable since both callbacks produce valid credentials from the same user's OAuth session.

This explicitly defines the behavior: multiple nonces allowed, last writer wins, and explains why this is acceptable (both produce valid credentials from the same OAuth session).
