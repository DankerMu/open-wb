#!/usr/bin/env bash
# Re-run only the missing or crashed samples of a control arm.
#
#   ./self/fill_gaps.sh <baseline-skill-dir> <control-out-dir> <K> [concurrency] [model]
#
# A control arm is expensive and quota failures are common, so a partial arm
# must be resumable. Restarting from scratch wastes the samples that succeeded
# and tempts you to lower K instead, which changes what is being measured.
set -uo pipefail
BASELINE="$(cd "${1:?}" && pwd)"; OUT="${2:?}"; K="${3:?}"; CONC="${4:-3}"; MODEL="${5:-sonnet}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASES=$(python3 -c "
import json;print(' '.join(c['id'] for c in json.load(open('$SELF_DIR/gt.json'))['cases']))")
i=0; gaps=0
for CASE in $CASES; do
  for S in $(seq 1 "$K"); do
    RUNS="$OUT/sample-$S/runs"; J="$OUT/sample-$S/judge/$CASE.json"
    [ -s "$J" ] && ! grep -q '"crashed": true' "$J" 2>/dev/null && continue
    gaps=$((gaps + 1))
    ( mkdir -p "$OUT/sample-$S/judge"
      "$SELF_DIR/run_case.sh" "$CASE" "$BASELINE" "$RUNS" "$MODEL" >/dev/null 2>&1
      [ ! -f "$RUNS/$CASE/_crashed.txt" ] && python3 "$SELF_DIR/judge.py" "$CASE" \
        "$RUNS/$CASE" --model "$MODEL" > "$J" 2>/dev/null ) &
    i=$((i + 1)); [ $((i % CONC)) -eq 0 ] && wait
  done
done
wait
echo "attempted $gaps gap(s)"
python3 "$SELF_DIR/control_summary.py" "$OUT" --k "$K" --baseline "$BASELINE" || true
