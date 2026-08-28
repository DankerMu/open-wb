# Ground Truth (GT) Format

## Contents
- Universal Case Structure
- Assertion Types (8 types)
- Execution Methods
- Difficulty Levels
- Dev/Holdout/Regression Split
- Generating GT from Scratch

## Universal Case Structure

Each GT case defines one test scenario — an input, what the artifact should produce, and how to check it:

```json
{
  "id": "case-01",
  "prompt": "The test input or stimulus",
  "expected_output": "Human-readable description of the correct result",
  "execution": {
    "method": "llm",
    "config": {}
  },
  "assertions": [
    {"type": "contains", "value": "expected substring"},
    {"type": "llm_judge", "value": "Does the output correctly explain X?"}
  ],
  "difficulty": "standard",
  "tags": ["routing", "edge-case"]
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `prompt` | Yes | The test input fed to the artifact |
| `expected_output` | Yes | Human description of correct behavior |
| `execution` | No | Override the default execution method (from evolve_plan.md) |
| `assertions` | Yes | At least 1 assertion; mix of programmatic and LLM-judged |
| `difficulty` | No | `standard`, `hard`, or `regression` |
| `tags` | No | Categories for stratified splitting |

## Assertion Types

### Programmatic (deterministic, evaluated by scripts/evaluate_assertions.py)

| Type | What It Checks | Example |
|------|---------------|---------|
| `contains` | Output includes a substring | `{"type": "contains", "value": "customer retention"}` |
| `not_contains` | Output excludes a substring | `{"type": "not_contains", "value": "TODO"}` |
| `regex` | Output matches a regex | `{"type": "regex", "value": "\\d{4}-\\d{2}-\\d{2}"}` |
| `file_exists` | A file was created at a path | `{"type": "file_exists", "value": "output/report.md"}` |
| `json_valid` | Output is valid JSON | `{"type": "json_valid"}` |
| `script` | A shell command exits 0 | `{"type": "script", "value": "pytest tests/test_func.py -x"}` |

### LLM-Judged (require LLM YES/NO classification)

| Type | What It Checks | Example |
|------|---------------|---------|
| `llm_judge` | General quality criterion | `{"type": "llm_judge", "value": "Is the argument logically consistent?"}` |
| `fact_coverage` | All listed facts appear | `{"type": "fact_coverage", "value": "market size | competitive advantage | risk factors"}` |

LLM-judged assertions use a simple prompt: "Given this output: {output}. Does it satisfy: {criterion}? Answer YES or NO only." The program counts YES responses.

### Choosing Assertion Types

Prefer programmatic assertions — they are deterministic and free. Use LLM-judged assertions only when the criterion requires semantic understanding.

| If you need to check... | Use |
|------------------------|-----|
| Presence of a keyword or phrase | `contains` |
| Absence of forbidden content | `not_contains` |
| A structured pattern (dates, IDs) | `regex` |
| File creation | `file_exists` |
| Output structure | `json_valid` |
| Test suite passes | `script` |
| Semantic quality | `llm_judge` |
| Knowledge completeness | `fact_coverage` |

## Execution Methods

The execution method defines how to produce output from the artifact for evaluation. Set the default in `evolve_plan.md`; individual cases can override.

### `llm` — LLM Invocation

For prompts, templates, and instruction-type artifacts. The artifact is sent as context to an LLM along with the test input.

```json
{
  "method": "llm",
  "config": {
    "model": "claude-sonnet-4-6",
    "system_prompt_from_artifact": true,
    "temperature": 0
  }
}
```

How it works: the artifact text becomes the system prompt (or is prepended to the user message). The case's `prompt` becomes the user message. Output is captured.

### `shell` — Shell Command Execution

For code artifacts. Runs a command that exercises the code and captures output.

```json
{
  "method": "shell",
  "config": {
    "command": "python -c \"from {module} import {func}; print({func}({input}))\"",
    "timeout_seconds": 30
  }
}
```

The `{input}` placeholder is replaced with the case's `prompt` field. stdout is captured as the output.

### `skill` — Claude Skill Invocation

For skill-type and harness-type artifacts. Runs claude with the candidate version of the skill supplied as context.

```json
{
  "method": "skill",
  "config": {
    "skill_path": "./",
    "cli_command": "claude -p \"{prompt}\" --append-system-prompt \"$(cat \"$SKILL_ABS/SKILL.md\")\" --allowedTools 'Read,Glob,Grep,Write,Edit,Bash' --setting-sources \"\" --disable-slash-commands --no-session-persistence"
  }
}
```

Three parts of that command are not stylistic:

- **`--setting-sources ""` and `--disable-slash-commands`.** Without them the run discovers the copy of the skill *installed on this machine* and reads that instead of the candidate. When this was first measured, the older arm opened its reply with "that copy is a stale version missing Pairwise Mode" — it had gone and read the newer skill, so both arms were evaluating the same file and the comparison was worthless.
- **An absolute path to the candidate's `SKILL.md`.** The runner usually `cd`s into a per-case directory first, and a relative path resolves to nothing there. The system prompt comes out empty and the run measures a bare model while looking entirely normal. Verify the file is non-empty before launching.
- **Copying the candidate's `references/` and `scripts/` into the run directory.** SKILL.md names them by relative path, so progressive disclosure only resolves if they sit at the working directory. Copy the wrong version's references and the arms blur together.

A working implementation of all of this ships at `self/run_case.sh` — read it before writing your own.

### `evaluate` — Direct LLM Evaluation

For ideas, documents, proposals — artifacts that aren't "run" but are "judged." The artifact text is given to an LLM alongside the assertion criteria, and the LLM evaluates directly.

```json
{
  "method": "evaluate",
  "config": {
    "model": "claude-sonnet-4-6"
  }
}
```

In this mode, the "output" IS the artifact itself. Assertions evaluate the artifact directly rather than its runtime output.

### `custom` — User-Defined

For anything else. The user provides the full execution command.

```json
{
  "method": "custom",
  "config": {
    "command": "your-command-here {prompt}",
    "output_file": "path/to/output"
  }
}
```

## Difficulty Levels

- `standard` — Normal use cases the artifact should handle
- `hard` — Edge cases, ambiguous inputs, adversarial scenarios
- `regression` — Cases that previously broke and must stay fixed

## GT File Structure

```json
{
  "artifact_name": "my-prompt",
  "artifact_type": "prompt",
  "default_execution": {
    "method": "llm",
    "config": {"temperature": 0}
  },
  "cases": [
    {"id": "case-01", "prompt": "...", "expected_output": "...", "assertions": [...]}
  ]
}
```

## Dev/Holdout/Regression Split

### Purpose

- **Dev (70%)**: The optimizer sees these every iteration. Mutations target failures here.
- **Holdout (20%)**: The optimizer NEVER sees results during iteration. Evaluated only in L3. Detects overfitting.
- **Regression (10% + grows)**: Cases passing at baseline. Any regression triggers automatic DISCARD.

### Split Strategy

1. Stratify by difficulty: each split gets proportional standard/hard cases
2. Stratify by tags: each split covers all categories
3. Fewer than 10 cases: skip holdout, use dev + regression only
4. The split is fixed for the entire session — never re-split mid-session

### Dynamic Growth

New GT cases discovered during evolution go to the dev set. Log additions in `experiments.jsonl`.

Cases failing 5+ consecutive iterations across all layers are candidates for GT review — the annotation itself may be wrong. Flag to the user.

Unfixable cases with bad GT should be excluded entirely (not moved to regression).

## Generating GT from Scratch

When no GT exists:

1. Analyze the artifact to understand its purpose, inputs, and expected outputs
2. Generate 10-15 representative test inputs spanning the artifact's scope
3. For each input, write expected output description + 2-4 assertions
4. Mix assertion types: aim for at least 60% programmatic, rest LLM-judged
5. Include 2-3 hard/edge cases
6. Present to the user for review and correction
7. Split into dev/holdout/regression

### When 60% Programmatic Is Not Reachable

The 60% target holds for artifacts whose output has checkable structure. It does not hold for artifacts whose output is *behavior* — a skill, an agent harness, a policy document. When the thing you need to check is "did it decline to start, and give a reason," there is no substring that establishes it. A model can decline while never using the word "decline," and can use the word while proceeding anyway.

Forcing the ratio in those cases produces assertions that pass on phrasing rather than on conduct, which is the assertion-gaming failure this skill warns about, introduced by the GT author instead of the loop.

So: write the programmatic assertion wherever a genuine one exists — a file that must be created, a field that must appear in a ledger, a validator that must exit zero, an identifier that must *not* leak. Then use `llm_judge` for the rest and record the actual ratio in `evolve_plan.md` rather than padding to hit a number. `self/gt.json` in this skill sits at 44% for exactly this reason.

A lower programmatic ratio raises the noise floor, so compensate where it counts: judge across model families, use multiple seeds, and treat sub-2% movements as noise. See `evaluation.md`.

The quality ceiling of evolution is bounded by GT quality. Bad GT = bad artifact, regardless of iteration count.
