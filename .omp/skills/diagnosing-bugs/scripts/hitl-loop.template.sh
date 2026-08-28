#!/usr/bin/env bash
# HITL diagnosis loop template (feedback-loop ladder rung 10 — last resort).
# The agent runs this script; the user follows the prompts in their terminal.
# The human is inside the loop, but the loop still feeds the agent: every
# captured value prints as a KEY=VALUE line at the end for the agent to parse.
#
# The agent customizes ONLY the region between the "edit below/above" markers.
set -euo pipefail

CAPTURED=()

# step "<instruction>" — print an instruction, block until the user hits Enter.
step() {
  printf '\n==> %s\n' "$1"
  read -r -p '    [Enter when done] '
}

# capture VAR "<question>" — ask a question, store the answer in $VAR.
capture() {
  local key="$1" question="$2" input
  printf '\n??  %s\n' "$question"
  read -r -p '    > ' input
  printf -v "$key" '%s' "$input"
  CAPTURED+=("$key")
}

# --- edit below: customize the steps for this bug ---------------------------
step "Start the app and log in as a regular user"
step "Navigate to where the bug occurs and trigger it once"
capture SYMPTOM "What exactly did you see? (error text, wrong value, blank screen)"
capture REPRODUCED "Did the bug happen this time? (yes/no)"
# --- edit above --------------------------------------------------------------

printf '\n--- captured values (for the agent) ---\n'
for key in "${CAPTURED[@]}"; do
  printf '%s=%s\n' "$key" "${!key}"
done
