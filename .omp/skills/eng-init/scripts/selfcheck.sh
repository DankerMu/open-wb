#!/usr/bin/env bash
# scripts/selfcheck.sh — run every gate this skill owns, in one command.
#
# eng-init requires target repos to have a single command that proves the
# repository's invariants. This is that command for eng-init itself. Run it
# before shipping any change to SKILL.md, references/, evals/, or scripts/.
#
# Missing prerequisites fail loud: a gate that cannot run has not passed, and
# reporting green for an unrun gate is the exact false-pass this skill exists
# to prevent.
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_ROOT"

failures=0
run_gate() {
  local name="$1"; shift
  printf '\n=== %s\n' "$name"
  if "$@"; then
    printf 'PASS %s\n' "$name"
  else
    printf '::error::FAIL %s\n' "$name"
    failures=$((failures + 1))
  fi
}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '::error::missing prerequisite: %s (%s)\n' "$1" "$2"
    exit 127
  }
}

# Discard bytecode caches before verifying anything. CPython validates a .pyc by
# (source mtime, source size), so a one-line edit that preserves length — a git
# revert, a mutation test, `if extra:` -> `if False:` — can leave a stale .pyc
# that the suite happily validates instead of the source on disk. Found exactly
# that way: a mutation run reported "nothing catches this" while the real check
# was intact, because pytest was executing the mutated bytecode. A gate that can
# pass on code that is no longer there is the failure this skill exists to catch.
find "$SKILL_ROOT" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

require python3 "install Python 3.10+"
python3 -c 'import pytest' 2>/dev/null || {
  printf '::error::missing prerequisite: pytest (pip install pytest) — the verifier suite cannot run, so this check cannot report green\n'
  exit 127
}

# --criteria-reference is load-bearing: without it the registry can drift out of
# sync with the markdown criteria table (a criterion in one and not the other).
run_gate "readiness registry contract + criteria cross-reference" \
  python3 scripts/check_readiness_registry.py references/readiness-registry.yaml \
    --criteria-reference references/agent-readiness-criteria.md
run_gate "readiness registry parses as standard YAML" \
  python3 -c 'import yaml,sys; yaml.safe_load(open("references/readiness-registry.yaml")); print("standard YAML OK")'
run_gate "skill content invariants" \
  python3 scripts/check_skill_content.py
run_gate "verifier fixture tests" \
  python3 -m pytest scripts/tests -q

# Prose asserts things the repository can disprove: a section was synced, a count
# is N, a named mechanism exists. Nothing checked those until a "fix" commit
# reported an edit that had silently not applied (postmortem 0002 instance 9).
run_gate "documented claims match the artifacts" \
  python3 scripts/check_doc_claims.py

# The two readiness validators are named in SKILL.md's reference index as the
# Audit and Repair pipeline verifiers. Until 2026-08-10 nothing executed them and
# nothing proved they reject anything — a program in the enforcement inventory
# that never runs is the phantom enforcement this skill exists to prevent. These
# smoke gates prove each one is invokable and still refuses a malformed payload,
# on top of the dual-assertion suite in scripts/tests/test_readiness_validators.py.
smoke_rejects() {
  local name="$1" script="$2" payload="$3"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/selfcheck.XXXXXX.json")"
  printf '%s' "$payload" > "$tmp"
  local out
  out="$(python3 "$script" "$tmp" --registry references/readiness-registry.yaml 2>&1)"
  local rc=$?
  rm -f "$tmp"
  if [ "$rc" -eq 0 ]; then
    printf '::error::%s accepted a malformed payload (exit 0)\n' "$name"
    return 1
  fi
  # Non-zero alone is not rejection: a traceback exits non-zero too, and a gate
  # that crashes has not judged anything. Require the protocol's violation
  # report, so a broken script cannot pass itself off as a working one.
  if ! printf '%s' "$out" | grep -q 'violation(s) found'; then
    printf '::error::%s exited %s without a protocol violation report — crash, not rejection:\n%s\n' \
      "$name" "$rc" "$out"
    return 1
  fi
  printf '%s rejected a malformed payload as required\n' "$name"
}

run_gate "readiness report scorer rejects malformed input" \
  smoke_rejects "score_readiness_report.py" scripts/score_readiness_report.py '{"applications":[],"score":{},"criteria":[]}'
run_gate "repair handoff validator rejects malformed input" \
  smoke_rejects "validate_readiness_repair.py" scripts/validate_readiness_repair.py '{"decision":"nonsense"}'

printf '\n'
if [ "$failures" -ne 0 ]; then
  printf '::error::selfcheck FAILED (%d gate(s))\n' "$failures"
  exit 1
fi
printf 'selfcheck PASSED — all gates green\n'
