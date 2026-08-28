#!/usr/bin/env bash
# Budget-matched control arm: does K samples of the BASELINE beat 1 of the evolved artifact?
#
#   ./self/control_arm.sh <baseline-skill-dir> <out-dir> <K> [concurrency] [model]
#
# Draws K independent samples per case from the baseline — never the evolved
# artifact — and writes <out-dir>/control_arm.json with pass@1 and pass@K.
#
# This is Arm A, parallel sampling, which was the strongest baseline in Wang et
# al. (Ai2, arXiv 2607.12227). Arm B (sequential refinement) is a separate run;
# budget-parity.md permits dropping it, since it loses the least.
#
# pass@1 is the mean score across the K samples, which is the unbiased estimate
# of drawing one at random. Using a self-judge to pick the best sample would
# measure the selector as much as the artifact, and would flatter the arm.
# pass@K is "any sample scored full marks" — it needs oracle selection, so it is
# an upper bound, not something you could deploy.
set -uo pipefail

BASELINE="${1:?usage: control_arm.sh <baseline-skill-dir> <out-dir> <K> [concurrency] [model]}"
OUT="${2:?missing out-dir}"
K="${3:?missing K}"
CONC="${4:-3}"
MODEL="${5:-sonnet}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASELINE="$(cd "$BASELINE" && pwd)" || { echo "no such baseline dir" >&2; exit 2; }
[ -f "$BASELINE/SKILL.md" ] || { echo "no SKILL.md in $BASELINE" >&2; exit 2; }

mkdir -p "$OUT"
CASES=$(python3 -c "
import json;print(' '.join(c['id'] for c in json.load(open('$SELF_DIR/gt.json'))['cases']))")

echo "control arm: K=$K samples/case of $BASELINE"

i=0
for CASE in $CASES; do
  for S in $(seq 1 "$K"); do
    ( RUNS="$OUT/sample-$S/runs"
      "$SELF_DIR/run_case.sh" "$CASE" "$BASELINE" "$RUNS" "$MODEL" >/dev/null 2>&1
      if [ ! -f "$RUNS/$CASE/_crashed.txt" ]; then
        mkdir -p "$OUT/sample-$S/judge"
        python3 "$SELF_DIR/judge.py" "$CASE" "$RUNS/$CASE" --model "$MODEL" \
          > "$OUT/sample-$S/judge/$CASE.json" 2>/dev/null
      fi ) &
    i=$((i + 1))
    [ $((i % CONC)) -eq 0 ] && wait
  done
done
wait

# One retry pass for anything that crashed or went unjudged.
for CASE in $CASES; do
  for S in $(seq 1 "$K"); do
    RUNS="$OUT/sample-$S/runs"; J="$OUT/sample-$S/judge/$CASE.json"
    if [ -f "$RUNS/$CASE/_crashed.txt" ] || [ ! -s "$J" ]; then
      echo "  retrying sample-$S/$CASE"
      "$SELF_DIR/run_case.sh" "$CASE" "$BASELINE" "$RUNS" "$MODEL" >/dev/null 2>&1
      [ ! -f "$RUNS/$CASE/_crashed.txt" ] && python3 "$SELF_DIR/judge.py" "$CASE" \
        "$RUNS/$CASE" --model "$MODEL" > "$J" 2>/dev/null
    fi
  done
done

python3 "$SELF_DIR/control_summary.py" "$OUT" --k "$K" --baseline "$BASELINE"
