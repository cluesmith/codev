#!/usr/bin/env bash
#
# extract-capability-inventory.sh — Spec 1280, criterion M5.
#
# Extracts every CAPABILITY the prompt surface communicates to an agent, so a
# rewrite can be proven not to have silently dropped one.
#
# THE INVENTORY IS OVER SERVED PROMPT TEXT, NOT OVER protocol.json.
# ------------------------------------------------------------------
# This distinction is the whole point (CMAP round 2 caught the earlier design
# doing the opposite). Extracting gate/check names from `protocol.json`, or
# notification names from `afx send` call sites, would report every capability
# as present even if every corresponding INSTRUCTION vanished from the prompts —
# because this project does not touch those files. `protocol.json` and the
# source tree supply the EXPECTED SET; the served prompt text is where each
# item must be found.
#
# REPRESENTATION (M5, reconciled with principle P6)
# -------------------------------------------------
# P6 permits replacing narrated names with a reference to structured truth. So a
# capability counts as represented if EITHER:
#   (a) it is named in served prompt text, OR
#   (b) the served text carries a resolvable `{{> ...}}` include of the source
#       that defines it (the include is expanded here before matching, so (b)
#       reduces to (a) automatically).
# A naive "the name must appear in prose" rule would fail a CONFORMANT rewrite.
#
# DETECTION LIMIT — stated, not implied
# -------------------------------------
# This detects DELETION of a capability. It does NOT detect INVERSION or
# GUTTING of the instruction attached to one: "a gate message is a notification
# to the human, not authorization" can collapse to a bare mention of the gate
# name and still pass. That gap is covered by M11 (architect reads every diff)
# and O4 (the A/B compliance checklist), not by this script.
#
# Usage:  scripts/extract-capability-inventory.sh [repo-root] > inventory.json
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

resolve() {
  if   [ -f ".codev/$1" ];         then echo ".codev/$1"
  elif [ -f "codev/$1" ];          then echo "codev/$1"
  elif [ -f "codev-skeleton/$1" ]; then echo "codev-skeleton/$1"
  else echo /dev/null; fi
}

# Served text of one file with {{> ...}} includes expanded (two levels).
expand() {
  local f="$1"; [ -f "$f" ] || return 0
  local body; body="$(cat "$f")"
  local inc ip
  for inc in $(grep -o '{{> *[^} ]*' "$f" 2>/dev/null | sed 's/{{> *//'); do
    ip="$(resolve "$inc")"
    [ -f "$ip" ] || continue
    body="$body
$(cat "$ip")"
    local inc2 ip2
    for inc2 in $(grep -o '{{> *[^} ]*' "$ip" 2>/dev/null | sed 's/{{> *//'); do
      ip2="$(resolve "$inc2")"
      [ -f "$ip2" ] && body="$body
$(cat "$ip2")"
    done
  done
  printf '%s\n' "$body"
}

# ---- the served prompt surface: every prompt-bearing file, both trees -------
served_corpus() {
  local f
  for f in CLAUDE.md AGENTS.md; do [ -f "$f" ] && expand "$f"; done
  for f in $(find codev/roles codev-skeleton/roles -name '*.md' 2>/dev/null); do expand "$f"; done
  for f in $(find codev/protocols codev-skeleton/protocols -name '*.md' 2>/dev/null); do expand "$f"; done
}

CORPUS="$(served_corpus)"

# ---- expected sets (from structured/source truth) --------------------------
GATES=$(python3 - <<'PY'
import json,glob
g=set()
for f in glob.glob('codev*/protocols/*/protocol.json'):
    try: d=json.load(open(f))
    except Exception: continue
    for p in d.get('phases',[]):
        v=p.get('gate')
        if isinstance(v,str): g.add(v)
        elif isinstance(v,dict) and isinstance(v.get('name'),str): g.add(v['name'])
print('\n'.join(sorted(g)))
PY
)
CHECKS=$(python3 - <<'PY'
import json,glob
c=set()
for f in glob.glob('codev*/protocols/*/protocol.json'):
    try: d=json.load(open(f))
    except Exception: continue
    for p in d.get('phases',[]):
        c |= set((p.get('checks') or {}).keys())
print('\n'.join(sorted(c)))
PY
)

# Normalization: lowercase, strip backticks/quotes/punctuation noise.
norm() { tr '[:upper:]' '[:lower:]' | tr -d '`"'"'"'*'; }
CORPUS_N="$(printf '%s' "$CORPUS" | norm)"

# NOTE: a here-string, deliberately NOT `printf ... | grep -q`.
# Under `set -o pipefail`, `grep -q` exits on its FIRST match and closes the
# pipe; the upstream printf then dies of SIGPIPE and the pipeline reports
# failure — so every capability that WAS found reported as absent. The exit
# status had two causes and the code read only one of them. (Same failure class
# this project has been recording: trust the authoritative signal, not the
# convenient one.)
present() {
  local needle; needle="$(printf '%s' "$1" | norm)"
  if grep -qF -- "$needle" <<<"$CORPUS_N"; then echo true; else echo false; fi
}

# ---- signals, artifact paths, notification triggers: found IN the corpus ----
SIGNALS=$(printf '%s' "$CORPUS" | grep -o '<signal[^>]*>[A-Z_]*' | grep -o '[A-Z_]\{4,\}' | sort -u || true)
ARTIFACTS=$(printf '%s' "$CORPUS" | grep -oE 'codev/(specs|plans|reviews|state)/[A-Za-z0-9{}_.*-]+' | sort -u || true)
NOTIFY=$(printf '%s' "$CORPUS" | grep -oE 'afx send [a-z:<>{}-]+' | sort -u || true)

json_array() { # each stdin line -> {"name":..,"present":..}
  local first=1
  while IFS= read -r item; do
    [ -z "$item" ] && continue
    [ $first -eq 1 ] || printf ',\n'
    first=0
    printf '    {"name": %s, "present_in_served_prompts": %s}' \
      "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$item")" "$(present "$item")"
  done
  [ $first -eq 1 ] || printf '\n'
}

cat <<EOF
{
  "_spec": "1280",
  "_criterion": "M5",
  "_basis": "served prompt text (includes expanded); protocol.json supplies the expected set only",
  "_detection_limit": "detects deletion, not inversion or gutting — see M11 and O4",
  "_commit": "$(git rev-parse --short HEAD 2>/dev/null || echo n/a)",
  "gates": [
$(printf '%s\n' "$GATES" | json_array)  ],
  "checks": [
$(printf '%s\n' "$CHECKS" | json_array)  ],
  "signals": [
$(printf '%s\n' "$SIGNALS" | json_array)  ],
  "artifact_paths": [
$(printf '%s\n' "$ARTIFACTS" | json_array)  ],
  "notification_triggers": [
$(printf '%s\n' "$NOTIFY" | json_array)  ]
}
EOF
