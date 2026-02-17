# Cloud Development Instances for Remote Codev

Guide for running codev on cloud VMs while traveling without reliable internet.

## Example Instance: GCP e2-standard-4

Example configuration for a GCP dev instance:

| Property | Value |
|----------|-------|
| Name | `codev-dev` |
| Zone | `us-west1-b` |
| Machine Type | `e2-standard-4` (4 vCPU, 16GB RAM) |
| Boot Disk | 50GB SSD |
| OS | Ubuntu 22.04 LTS |

### Installed Tools

- Node.js v20.x
- npm 10.x
- Claude Code
- Codex CLI
- git

### Quick Start

```bash
# Connect from your laptop
gcloud compute ssh <instance-name> --zone=us-west1-b

# Or use af for Agent Farm
af dash start --remote <username>@<external-ip>:/home/<username>/dev/your-project

# Set API keys (first time only)
gcloud compute ssh <instance-name> --zone=us-west1-b --command='
cat >> ~/.bashrc << "EOF"
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
EOF
source ~/.bashrc
'
```

### Management Commands

```bash
# Check status
gcloud compute instances describe <instance-name> --zone=us-west1-b --format="table(status,networkInterfaces[0].accessConfigs[0].natIP)"

# Stop (saves money, keeps disk)
gcloud compute instances stop <instance-name> --zone=us-west1-b

# Start
gcloud compute instances start <instance-name> --zone=us-west1-b

# Delete (removes everything)
gcloud compute instances delete <instance-name> --zone=us-west1-b

# Create snapshot before deleting
gcloud compute disks snapshot <instance-name> --zone=us-west1-b --snapshot-names=<instance-name>-snapshot
```

### Estimated Cost

- Running 24/7: ~$100/mo
- Running 8h/day weekdays: ~$35/mo
- Stopped: ~$4/mo (disk storage only)

**Tip**: Stop the instance when not in use. Start it when you need it.

---

## Requirements

- 4+ vCPU, 8GB+ RAM for running multiple builder agents
- SSD storage for responsive git/sqlite operations
- SSH access for `af dash start --remote`
- Ability to snapshot/destroy to minimize costs

## Recommendations

### Top Pick: Hetzner Cloud CX33 (~$7/mo)

**Why**: Best value for the specs needed. All three external consultants (Gemini, Codex, Claude) flagged Hetzner as optimal.

| Spec | Value |
|------|-------|
| vCPU | 4 (shared) |
| RAM | 8GB |
| Storage | 80GB NVMe SSD |
| Bandwidth | 20TB |
| Location | EU (Falkenstein, Nuremberg, Helsinki) |
| Price | ~€6/mo (~$7/mo) |

**Pros**:
- Cheapest for the specs
- Pay-as-you-go, hourly billing
- Snapshot before trips, destroy, restore when needed
- Simple API for automation

**Cons**:
- EU datacenters only (higher latency from US)
- Less ecosystem than AWS/GCP

### Alternative: DigitalOcean or GCP ($15-25/mo)

For US West proximity (lower latency):

**DigitalOcean Droplet** (Basic, Regular Intel):
- 4 vCPU, 8GB RAM, 160GB SSD: $48/mo
- 2 vCPU, 4GB RAM, 80GB SSD: $24/mo (workable for light use)
- SF datacenter available

**GCP e2-standard-2**:
- 2 vCPU, 8GB RAM
- ~$4.68 for 40 hours/week (spot pricing available)
- us-west1 (Oregon) datacenter
- More complex billing

### Free Option: Oracle Cloud Free Tier

**ARM Instance** (always free):
- 4 OCPU, 24GB RAM
- 200GB block storage

**Caveats**:
- ARM architecture - some npm packages may have issues
- Complex signup process, may require credit card verification
- Availability varies by region

### For Quick Sessions: GitHub Codespaces

- $0.18/hr for 4-core machine
- Best for occasional 2-4 hour sessions
- No maintenance burden
- Includes VS Code in browser

**Not recommended** for extended async agent work due to:
- Session timeouts
- Cost adds up for long-running agents
- Less control over environment

## Setup Script (Hetzner/DO/Generic Linux)

```bash
#!/bin/bash
# cloud-dev-setup.sh - Run on fresh Ubuntu 22.04+ instance

set -e

# System updates
apt update && apt upgrade -y

# Essential tools
apt install -y \
  git \
  curl \
  build-essential \
  sqlite3

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# AI CLIs
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex

# Optional: Gemini CLI (requires Go)
# apt install -y golang-go
# go install github.com/google-gemini/gemini-cli@latest

# Create dev user (optional, can use root)
useradd -m -s /bin/bash dev
usermod -aG sudo dev

# SSH key setup (copy your public key)
mkdir -p /home/dev/.ssh
# echo "your-public-key" >> /home/dev/.ssh/authorized_keys
chown -R dev:dev /home/dev/.ssh
chmod 700 /home/dev/.ssh
chmod 600 /home/dev/.ssh/authorized_keys

echo "Setup complete. Clone your repos and configure API keys."
```

## Usage from Laptop

```bash
# Start agent farm on remote instance
af dash start --remote dev@your-instance-ip:/path/to/project

# This:
# 1. SSHs into the remote machine
# 2. Starts Agent Farm there
# 3. Sets up SSH tunnel to your localhost
# 4. Opens http://localhost:4200 in your browser
```

## Cost Optimization Tips

1. **Snapshot before trips**: Create image, destroy instance, restore on arrival
2. **Hourly billing**: Hetzner/DO bill hourly - destroy when not in use
3. **Spot/preemptible instances**: GCP offers 60-90% discounts (risk of termination)
4. **Reserved instances**: If traveling frequently, 1-year reserved can save 30-50%

## Environment Variables

Store in `~/.bashrc` or `~/.profile` on the instance:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="..."
```

## Comparison Matrix

| Provider | Config | Monthly Cost | US West? | Notes |
|----------|--------|--------------|----------|-------|
| GCP e2-standard-4 | 4 vCPU, 16GB | ~$100 (24/7) / ~$35 (8h/day) | Yes | Recommended for US |
| Hetzner CX33 | 4 vCPU, 8GB | ~$7 | No | Best value |
| Hetzner CPX31 | 4 vCPU, 8GB | ~$17 | No | Dedicated CPU |
| DigitalOcean | 2 vCPU, 4GB | $24 | Yes | Simple |
| GCP e2-standard-2 | 2 vCPU, 8GB | ~$49 (or $5/40hr) | Yes | Smaller option |
| Oracle Free | 4 OCPU, 24GB | $0 | Yes | ARM, complex setup |
| Codespaces | 4-core | $0.18/hr | N/A | Session-based |

## Security Notes

- Use SSH keys only, disable password auth
- Consider fail2ban for brute force protection
- Keep API keys in environment variables, not in repos
- Firewall: only expose SSH (22) and tunneled ports

---

*Generated from 3-way consultation (Gemini, Codex, Claude) - December 2024. Updated February 2026 (removed tmux dependency — Agent Farm now uses Shellper for terminal management).*
