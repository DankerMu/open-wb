#!/usr/bin/env bash
# Materialize a scratch working directory for one self-evolution GT case.
#
#   ./self/setup_case.sh case-04-plan-has-budget /tmp/se-cases
#
# Prints the scratch directory. Run the case with that as cwd, with SKILL_DIR
# exported — script assertions reference "$SKILL_DIR/scripts/...", so a case
# run from anywhere else will fail on a path rather than on behavior.
set -euo pipefail

CASE_ID="${1:?usage: setup_case.sh <case-id> [root]}"
ROOT="${2:-${TMPDIR:-/tmp}/self-evolution-cases}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK="$ROOT/$CASE_ID"
# A previous run left the fixture GT read-only, which would block rm.
[ -e "$WORK" ] && chmod -R u+w "$WORK"
rm -rf "$WORK"
mkdir -p "$WORK"
cp -R "$SKILL_DIR/self/fixtures/." "$WORK/"

# Fixtures are the oracle's inputs, so a case must not be able to edit them
# and call the result a pass. Read-only is the cheap enforcement; the
# scope-violation check in L1 is the one that reports a breach.
chmod -R a-w "$WORK/demo-evolution/gt"

echo "$WORK"
