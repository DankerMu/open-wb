#!/usr/bin/env bash
# Run the whole self-evolution GT suite against a pinned skill and emit L2 results.
#
#   ./self/run_suite.sh <pinned-skill-dir> <out-dir> [concurrency] [model]
#
# Writes <out-dir>/l2_results.json in the format references/evaluation.md
# specifies, plus per-case transcripts and judgements under <out-dir>/runs/.
#
# Crashed runs are retried once. `claude` exits 0 on an internal failure and
# writes "Execution error" as the entire reply, so an unretried crash reads as
# a behavioural regression — three were misread that way before this existed.
set -uo pipefail

SKILL="${1:?usage: run_suite.sh <pinned-skill-dir> <out-dir> [concurrency] [model]}"
OUT="${2:?missing out-dir}"
CONC="${3:-4}"
MODEL="${4:-sonnet}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS="$OUT/runs"
JUDGE="$OUT/judge"
# Fixture GT is left read-only by design; restore write so a re-run can clear it.
[ -d "$RUNS" ] && chmod -R u+w "$RUNS" 2>/dev/null
mkdir -p "$RUNS" "$JUDGE"

CASES=$(python3 -c "
import json;print(' '.join(c['id'] for c in json.load(open('$SELF_DIR/gt.json'))['cases']))")

echo "suite: $(echo "$CASES" | wc -w) cases against $SKILL (concurrency $CONC)"

i=0
for CASE in $CASES; do
  ( "$SELF_DIR/run_case.sh" "$CASE" "$SKILL" "$RUNS" "$MODEL" >/dev/null 2>&1 ) &
  i=$((i + 1))
  [ $((i % CONC)) -eq 0 ] && wait
done
wait

for CASE in $CASES; do
  if [ -f "$RUNS/$CASE/_crashed.txt" ]; then
    echo "  retrying crashed: $CASE"
    "$SELF_DIR/run_case.sh" "$CASE" "$SKILL" "$RUNS" "$MODEL" >/dev/null 2>&1
  fi
done

i=0
for CASE in $CASES; do
  ( python3 "$SELF_DIR/judge.py" "$CASE" "$RUNS/$CASE" --model "$MODEL" \
      > "$JUDGE/$CASE.json" 2>/dev/null ) &
  i=$((i + 1))
  [ $((i % CONC)) -eq 0 ] && wait
done
wait

python3 "$SELF_DIR/aggregate.py" "$OUT" --skill "$SKILL"
