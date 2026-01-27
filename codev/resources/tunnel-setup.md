# Tower Remote Access Setup

This guide explains how to securely access Agent Farm's Tower dashboard from any device, including phones and tablets.

## Overview

Tower runs on `localhost:4100` by default. To access it remotely, you need:
1. An API key for authentication
2. A tunnel service to expose Tower to the internet

## Quick Start

```bash
# Generate API key
codev web keygen

# Set the key (add to ~/.bashrc or ~/.zshrc for persistence)
export CODEV_WEB_KEY="<your-key>"

# Start Tower
codev tower start

# In another terminal, start tunnel
cloudflared tunnel --url http://localhost:4100
```

## Step-by-Step Setup

### 1. Generate an API Key

```bash
codev web keygen
```

This generates a cryptographically secure 256-bit key in Base64URL format. Copy the generated key.

### 2. Set the Environment Variable

```bash
# For current session
export CODEV_WEB_KEY="your-generated-key"

# For persistence, add to your shell profile (~/.zshrc or ~/.bashrc)
echo 'export CODEV_WEB_KEY="your-generated-key"' >> ~/.zshrc
```

### 3. Start Tower

```bash
codev tower start
```

When `CODEV_WEB_KEY` is set, Tower requires authentication for ALL requests. There is no localhost bypass because tunnel daemons (cloudflared, ngrok) run locally.

### 4. Choose a Tunnel Service

#### Cloudflare Tunnel (Recommended)

Free, no account required for quick tunnels, supports WebSockets.

```bash
# Install
brew install cloudflared

# Create quick tunnel (temporary URL)
cloudflared tunnel --url http://localhost:4100
```

The command outputs a URL like `https://random-name.trycloudflare.com`.

For persistent tunnels with custom domains, create a Cloudflare account and configure a named tunnel.

#### ngrok

Popular option with free tier. Requires account for persistent URLs.

```bash
# Install
brew install ngrok

# Create tunnel
ngrok http 4100
```

#### Tailscale Funnel

If you're already using Tailscale for your network:

```bash
# Enable funnel and expose port
tailscale funnel --bg 4100
```

### 5. Access from Your Device

1. Open the tunnel URL in any browser
2. You'll see a login page asking for your API key
3. Enter the same key you set in `CODEV_WEB_KEY`
4. The key is stored in `localStorage` for future visits
5. Use the "Logout" button to clear the stored key

## Architecture

```
┌─────────────┐     HTTPS      ┌─────────────────┐      HTTP       ┌────────────┐
│   Phone     │ ────────────▶  │  Tunnel Daemon  │ ──────────────▶ │   Tower    │
│   Browser   │                │  (cloudflared)  │                 │ :4100      │
└─────────────┘                └─────────────────┘                 └────────────┘
                                    (local)                         (local)
```

- Phone connects via HTTPS to tunnel service
- Tunnel daemon runs locally and forwards to Tower
- Tower validates API key via `Authorization: Bearer <key>` header
- WebSocket connections pass auth via `Sec-WebSocket-Protocol: auth-<key>`

## Security Considerations

### No Localhost Bypass

When `CODEV_WEB_KEY` is set, **all requests require authentication**, including those from localhost. This is intentional because:

- Tunnel daemons run locally and proxy remote traffic
- Checking `req.socket.remoteAddress` would show localhost for all traffic
- Remote attackers could bypass auth if we trusted localhost

### Timing-Safe Comparison

API keys are compared using `crypto.timingSafeEqual()` to prevent timing attacks.

### HTTPS

All tunnel services provide HTTPS automatically. Never expose Tower directly via HTTP over the internet.

### Key Rotation

Consider rotating your API key periodically:

```bash
# Generate new key
codev web keygen

# Update environment
export CODEV_WEB_KEY="<new-key>"

# Restart Tower
codev tower stop
codev tower start

# Log in again on your devices with the new key
```

## Troubleshooting

### "Unauthorized" errors

- Verify `CODEV_WEB_KEY` is set: `echo $CODEV_WEB_KEY`
- Check the key matches what you entered in the browser
- Clear localStorage and re-enter the key

### WebSocket connection fails

- Ensure your tunnel supports WebSockets (cloudflared and ngrok do)
- Check browser console for specific error messages

### Can't access from phone

- Make sure you're using the tunnel URL, not `localhost`
- Verify the tunnel is running and healthy
- Try accessing from your computer first to verify setup

## Terminal Routing

Tower's reverse proxy routes requests to individual terminals:

| URL Pattern | Destination |
|-------------|-------------|
| `/project/<path>/` | Project dashboard (base_port) |
| `/project/<path>/architect/` | Architect terminal (base_port + 1) |
| `/project/<path>/builder/<n>/` | Builder n terminal (base_port + 2 + n) |

The `<path>` is the project path encoded in Base64URL format (RFC 4648).
