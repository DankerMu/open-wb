# Evolution Plan — demo (fixture)

artifact:              ./demo_prompt.md
artifact_type:         prompt
mode:                  gt
editable_scope:        ./demo_prompt.md
forbidden_scope:       ./gt/
run_command:           claude -p "{prompt}"
metric_name:           pass_rate
metric_direction:      maximize
metric_parse_rule:     dev_pass_rate from l2_results.json
timeout_seconds:       120
total_budget:          200
execution_model_tier:  frontier
hard_constraints:      none
soft_costs:            tokens per case
keep_rule:             pass_rate improves, or ties with a deletion or cost win
discard_rule:          crash, regression, worse pass_rate, scope violation, safety failure

## Control-arm plan
Runs on dev (10 cases). K derived from the ledger at Phase 8.
