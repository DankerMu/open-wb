# case-05 — iteration 6

## Input
Give the headcount figure.

## Execution
claude -p "Give the headcount figure." (demo_prompt.md as system prompt)

## Raw output
Headcount grew over the period, ending materially above where it started.

## Assertions
- regex "\d+" -> FAIL (no digit appears anywhere in the output)

## Timing
duration_s: 4.3 | tokens: 590
