#!/bin/bash
# Spike task-Iptx — Kimi Code CLI empirical probes (kimi 0.27.0, 2026-07-18)
#
# Reproduces the observations in task-Iptx-kimi-code-cli-support.md.
# Requirements: authenticated `kimi` on PATH, `script` (util-linux), python3.
# Probes 5–10 make small real model calls. Run from any scratch directory.
#
# NOTE: results are OBSERVATIONS against kimi 0.27.0, not documented guarantees.
set -u
S="$(mktemp -d)/kimi-poc"; mkdir -p "$S"
echo "scratch: $S"

echo "== 1. positional prompt (expect: unknown command, exit 1)"
kimi __codev_probe__; echo "exit=$?"

echo "== 2. role flags (expect: unknown option/command, exit 1)"
kimi --append-system-prompt x; echo "exit=$?"
kimi -c model_instructions_file=/tmp/x; echo "exit=$?"   # -c is --continue in kimi

echo "== 3. session store layout (expect: wd_<basename>_<hash>/session_<uuid>/state.json)"
find ~/.kimi-code/sessions -maxdepth 2 | head -8
head -2 ~/.kimi-code/session_index.jsonl

echo "== 4. doctor (config-only validation, exit 0)"
kimi doctor; echo "exit=$?"

echo "== 5. --continue with no prior session (expect: graceful fresh start, exit 0)"
mkdir -p "$S/empty" && cd "$S/empty"
kimi --continue -p "Reply with exactly: OK"; echo "exit=$?"

echo "== 6. stream-json session id capture (expect: session.resume_hint meta line)"
OUT=$(kimi -p "Reply with exactly: PONG" --output-format stream-json)
echo "$OUT"
SID=$(echo "$OUT" | python3 -c "import json,sys
for l in sys.stdin:
    o=json.loads(l)
    if o.get('type')=='session.resume_hint': print(o['session_id'])")
echo "captured SID=$SID"

echo "== 7. pinned-ID non-interactive resume (expect: context recalled)"
kimi -S "$SID" -p "What exact reply did I ask for before? One line."; echo "exit=$?"

echo "== 8. bogus session id (expect: fast fail, exit 1)"
kimi -S session_00000000-0000-0000-0000-000000000000 -p hi; echo "exit=$?"

echo "== 9. seed-session bootstrap: seed role via -p, resume in TUI, verify role retention"
mkdir -p "$S/seed" && cd "$S/seed"
OUT=$(kimi -p "ROLE BRIEFING: begin every reply with the exact token ROLE-OK followed by a space. Acknowledge and wait. Do not use tools." --output-format stream-json)
SID=$(echo "$OUT" | python3 -c "import json,sys
for l in sys.stdin:
    o=json.loads(l)
    if o.get('type')=='session.resume_hint': print(o['session_id'])")
echo "seed SID=$SID"
{ sleep 5; printf 'What is your role token? Reply per your briefing.'; sleep 1; printf '\r'
  sleep 45; printf '\x03'; sleep 1; printf '\x03'; sleep 2; } |
  script -qec "timeout 70 kimi -S $SID --yolo" /dev/null >/dev/null 2>&1
WD=$(ls -d ~/.kimi-code/sessions/wd_seed_* 2>/dev/null | head -1)
echo "--- assistant turns (expect ROLE-OK prefix on the interactive turn too):"
grep -o '"part":{"type":"text","text":"[^"]*"' "$WD/$SID/agents/main/wire.jsonl" | tail -3

echo "== 10. submit-timing: message-write.ts pacing (80ms Enter) vs 1s Enter"
for delay in 0.08 1; do
  mkdir -p "$S/ml-$delay" && cd "$S/ml-$delay"
  { sleep 5; printf 'line one\n'; sleep 0.01; printf 'line two\n'; sleep 0.01
    printf 'reply with exactly ML-OK'; sleep "$delay"; printf '\r'
    sleep 40; printf '\x03'; sleep 1; printf '\x03'; sleep 2; } |
    script -qec "timeout 65 kimi --yolo" /dev/null >/dev/null 2>&1
  WD=$(ls -d ~/.kimi-code/sessions/wd_ml-${delay}_* 2>/dev/null | head -1)
  LP=$(python3 -c "import json,glob
f=sorted(glob.glob('$WD/session_*/state.json'))[-1]
print(json.load(open(f)).get('lastPrompt'))" 2>/dev/null)
  echo "enter-delay=${delay}s -> lastPrompt: $LP"   # 0.08 -> None (not submitted); 1 -> full message
done

echo "== 11. AGENTS.md read natively (expect XYZZY-7 prefix)"
mkdir -p "$S/agentsmd" && cd "$S/agentsmd"
printf '# Project instructions\n\nIMPORTANT: Begin every reply with the exact token XYZZY-7 followed by a space.\n' > AGENTS.md
kimi -p "Say hello in three words."

echo "== 12. KIMI_CODE_HOME redirect (test seam)"
KIMI_CODE_HOME="$S/home" kimi doctor; echo "exit=$?"
