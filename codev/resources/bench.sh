#!/bin/bash
# Codev microbenchmark: same consultation prompt across 3 engines
# Usage: ./bench.sh [iterations] [--sequential]
# Results go to bench-results/
# Engines run in parallel by default (use --sequential for old behavior)

set -euo pipefail

ITERATIONS=${1:-3}
SEQUENTIAL=false
for arg in "$@"; do
  [[ "$arg" == "--sequential" ]] && SEQUENTIAL=true
done

RESULTS_DIR="$(dirname "$0")/bench-results"
PROMPT="Please analyze the codev codebase and give me a list of potential impactful improvements."

mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
HOSTNAME=$(hostname -s)
OUTFILE="$RESULTS_DIR/bench-${HOSTNAME}-${TIMESTAMP}.txt"

echo "=== Codev Consultation Benchmark ===" | tee "$OUTFILE"
echo "Host: $(hostname)" | tee -a "$OUTFILE"
echo "Date: $(date)" | tee -a "$OUTFILE"
echo "CPU: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || lscpu 2>/dev/null | grep 'Model name' | sed 's/.*: //' || echo 'unknown')" | tee -a "$OUTFILE"
echo "RAM: $(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f GB", $1/1073741824}' || free -h 2>/dev/null | awk '/Mem:/{print $2}' || echo 'unknown')" | tee -a "$OUTFILE"
echo "Iterations: $ITERATIONS" | tee -a "$OUTFILE"
echo "Mode: $( $SEQUENTIAL && echo 'sequential' || echo 'parallel' )" | tee -a "$OUTFILE"
echo "Prompt: $PROMPT" | tee -a "$OUTFILE"
echo "" | tee -a "$OUTFILE"

run_engine() {
  local engine=$1 iteration=$2 timestamp=$3 results_dir=$4 prompt=$5
  local run_out="$results_dir/${engine}-run${iteration}-${timestamp}.txt"
  local start end elapsed

  start=$(date +%s.%N 2>/dev/null || python3 -c 'import time; print(time.time())')
  consult -m "$engine" --prompt "$prompt" > "$run_out" 2>&1 || true
  end=$(date +%s.%N 2>/dev/null || python3 -c 'import time; print(time.time())')
  elapsed=$(python3 -c "print(f'{${end} - ${start}:.1f}')")

  echo "$elapsed"
}

for i in $(seq 1 "$ITERATIONS"); do
  echo "--- Iteration $i/$ITERATIONS ---" | tee -a "$OUTFILE"

  if $SEQUENTIAL; then
    for engine in gemini codex claude; do
      echo -n "  $engine... " | tee -a "$OUTFILE"
      elapsed=$(run_engine "$engine" "$i" "$TIMESTAMP" "$RESULTS_DIR" "$PROMPT")
      echo "${elapsed}s" | tee -a "$OUTFILE"
    done
  else
    # Run all 3 engines in parallel, collect results
    for engine in gemini codex claude; do
      run_engine "$engine" "$i" "$TIMESTAMP" "$RESULTS_DIR" "$PROMPT" > "$RESULTS_DIR/.${engine}-time-${i}" &
    done

    PAR_START=$(date +%s.%N 2>/dev/null || python3 -c 'import time; print(time.time())')
    wait
    PAR_END=$(date +%s.%N 2>/dev/null || python3 -c 'import time; print(time.time())')
    WALL=$(python3 -c "print(f'{${PAR_END} - ${PAR_START}:.1f}')")

    for engine in gemini codex claude; do
      elapsed=$(cat "$RESULTS_DIR/.${engine}-time-${i}")
      echo "  $engine: ${elapsed}s" | tee -a "$OUTFILE"
      rm -f "$RESULTS_DIR/.${engine}-time-${i}"
    done
    echo "  wall: ${WALL}s" | tee -a "$OUTFILE"
  fi

  echo "" | tee -a "$OUTFILE"
done

echo "=== Summary ===" | tee -a "$OUTFILE"
echo "Results saved to: $OUTFILE"
echo "Individual outputs in: $RESULTS_DIR/"
