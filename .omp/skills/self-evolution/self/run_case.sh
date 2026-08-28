#!/usr/bin/env bash
# Execute one self-evolution GT case against a pinned copy of the skill.
#
#   ./self/run_case.sh <case-id> <pinned-skill-dir> <run-root> [model]
#
# Prints the run directory. The transcript lands at <run-dir>/_transcript.txt.
#
# Two things here are load-bearing and were learned the hard way:
#
#   1. Isolation. Without --setting-sources "" the run discovers the skill
#      installed on this machine, reads it, and reports on THAT instead of the
#      pinned copy. A pilot run of v1.0.0 opened with "that copy is a stale
#      version missing Pairwise Mode" — it had gone and read the newer skill.
#      Every measurement taken that way is comparing the same version to itself.
#
#   2. The pinned skill's own references/ and scripts/ are copied into the run
#      directory. SKILL.md refers to `references/x.md` and `scripts/y.py` as
#      relative paths, so progressive disclosure only resolves if they sit at
#      cwd. Copy the wrong version's references and the arms silently blur.
set -uo pipefail

CASE_ID="${1:?usage: run_case.sh <case-id> <pinned-skill-dir> <run-root> [model]}"
SKILL="${2:?missing pinned-skill-dir}"
RUN_ROOT="${3:?missing run-root}"
MODEL="${4:-sonnet}"
TIMEOUT="${RUN_CASE_TIMEOUT:-300}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Absolute, because the pinned skill is read AFTER cd into the run directory.
# A relative path silently resolves to nothing there, the system prompt comes
# out empty, and the run measures a bare model while looking entirely normal.
SKILL="$(cd "$SKILL" 2>/dev/null && pwd)" || { echo "no such skill dir: ${2}" >&2; exit 2; }
[ -f "$SKILL/SKILL.md" ] || { echo "no SKILL.md in $SKILL" >&2; exit 2; }
RUN_ROOT="$(mkdir -p "$RUN_ROOT" && cd "$RUN_ROOT" && pwd)"

WORK="$RUN_ROOT/$CASE_ID"
chmod -R u+w "$WORK" 2>/dev/null   # a prior run left the fixture GT read-only
rm -rf "$WORK"
mkdir -p "$WORK"

cp -R "$SELF_DIR/fixtures/." "$WORK/"
cp -R "$SKILL/references" "$WORK/references"
cp -R "$SKILL/scripts" "$WORK/scripts"

# The oracle must not be editable by the thing being measured. case-14 asks the
# loop to loosen a failing assertion; read-only makes compliance fail loudly
# instead of passing quietly.
chmod -R a-w "$WORK"/*/gt 2>/dev/null

PROMPT="$(python3 "$SELF_DIR/case_prompt.py" "$CASE_ID")"
[ -n "$PROMPT" ] || { echo "unknown case: $CASE_ID" >&2; exit 2; }

SYSTEM_PROMPT="$(cat "$SKILL/SKILL.md")"
[ -n "$SYSTEM_PROMPT" ] || { echo "empty system prompt from $SKILL/SKILL.md" >&2; exit 2; }

cd "$WORK"
export SKILL_DIR="$WORK"
timeout "$TIMEOUT" claude -p "$PROMPT" \
  --append-system-prompt "$SYSTEM_PROMPT" \
  --allowedTools 'Read,Glob,Grep,Write,Edit,Bash' \
  --model "$MODEL" \
  --setting-sources "" --disable-slash-commands --no-session-persistence \
  > "$WORK/_transcript.txt" 2> "$WORK/_stderr.txt"
echo "$?" > "$WORK/_exit.txt"

# `claude` exits 0 on an internal failure and writes "Execution error" as the
# whole reply. Scoring that as a behavioural failure silently corrupts a run:
# three of these were read as real regressions before the pattern was noticed.
# Quota exhaustion arrives as ordinary prose ("You've hit your session limit"),
# not as an error, so without this the limit message gets scored as the agent's
# answer. Same for internal failures, which exit 0 with "Execution error".
if [ ! -s "$WORK/_transcript.txt" ] \
   || grep -qx 'Execution error' "$WORK/_transcript.txt" \
   || grep -qiE 'session limit|usage limit|rate limit|quota' "$WORK/_transcript.txt"; then
  echo "CRASHED" > "$WORK/_crashed.txt"
  head -c 200 "$WORK/_transcript.txt" > "$WORK/_crash_reason.txt" 2>/dev/null
fi

echo "$WORK"
