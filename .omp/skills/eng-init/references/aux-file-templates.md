# Auxiliary File Templates

Templates for every non-AGENTS.md file this skill may produce. Read this file in Stage 4 (Write), once you know which auxiliary files were selected during Stage 2.

Every eng-init template uses upper-snake placeholders such as `{{PLACEHOLDER}}`. Substitute those fully before writing; lowercase runtime placeholders in consumer files (for example `{{domain}}` in issue templates) and GitHub Actions expressions such as `${{ github.sha }}` are not eng-init placeholders.

## File index

| File | Section below | Mandatory when |
|------|---------------|----------------|
| `justfile`, `Makefile`, or `package.json` scripts | § Dev entry | Pillar 2 selected |
| `constraints.yaml` | § constraints.yaml | Always — machine-readable single source of truth for thresholds. Referenced by CI scripts and lint configs. |
| `.husky/pre-commit` or `.pre-commit-config.yaml` | § Pre-commit hooks | Always (because Code Canonicality requires the naming guard) |
| `.git-hooks/check-naming.sh` | § Naming guard script | Always |
| `commitlint.config.js` / stack-native equivalent | § Commit linting | When Q6.1 = yes |
| `.gitmessage` | § Commit template | When Q6.1 = yes |
| `.editorconfig` | § Editor config | Always |
| `.github/workflows/ci.yml` | § CI workflow | Pillar 5 selected |
| `.github/PULL_REQUEST_TEMPLATE.md` | § PR template | Always (cheap, high value) |
| `.github/ISSUE_TEMPLATE/*` | § Issue templates | When team size ≥ small team |
| Lint configs (per stack) | § Lint configs (per stack) | When Pillar 3 selected |
| `tsconfig.json` + `.prettierrc.json` | § TS toolchain configs | When TypeScript stack — **mandatory write set, AGENTS.md Enforcement Index will reference them** |
| Stack-specific duplicate/dead-code config | § Anti-drift configs | When Pillar 3 anti-drift trio selected |
| `package.json` / `pyproject.toml` skeleton | § Stack skeletons | Greenfield Node/Python when no manifest exists |
| `.gitignore` | § Gitignore templates | When missing |
| `renovate.json` | § Renovate | When Q2.5 = Renovate |
| Selected-entry runtime block (dev-bg, dev-stop, dev-status, logs, smoke, e2e, verify-ui, db-reset, seed, test-guardrails) | see `references/agent-harness-templates.md` § Runtime command block | L2+ when a long-running process or API/UI/DB/job runtime surface exists; otherwise render only the selected-entry core/check/test scripts that are actually used |
| `smoke/*.hurl` | see `references/agent-harness-templates.md` § API smoke — Hurl templates | Recommended at L2, required at L3+ |
| Playwright baseline (`playwright.config.*` + smoke spec) | see `references/agent-harness-templates.md` § UI smoke — Playwright baseline | L3+ when a UI exists |
| `scripts/test-guardrails.sh` | see `references/agent-harness-templates.md` § Guardrail self-test | L2+ |
| `.claude/settings.json` | see `references/agent-harness-templates.md` § Agent-native enforcement (.claude/settings.json) | Conditional — Claude Code among the AI tools (Q1.5) |
| `.claude/hooks/pre-write-naming.sh` | see `references/agent-harness-templates.md` § Agent-native enforcement (.claude/settings.json) | Conditional — written together with `.claude/settings.json` |
| `.tool-versions` / `.devcontainer/` | see `references/agent-harness-templates.md` § Toolchain pinning | Conditional — per the Environment tiers decision |
| `CODEOWNERS` | see `references/agent-harness-templates.md` § CODEOWNERS critical paths | Conditional — when Critical Paths (Q7.6) are enumerated |

---

## § Naming guard script (always)

This is the highest-leverage single file this skill produces. It is what blocks the "v1/v2/v3" failure mode at commit time.

Path: `.git-hooks/check-naming.sh` (chmod +x after writing).

```bash
#!/usr/bin/env bash
# .git-hooks/check-naming.sh
# Rejects commits that add files whose names violate code-canonicality rules.
# Wired into pre-commit via .husky/pre-commit or .pre-commit-config.yaml.
#
# See AGENTS.md § Code Canonicality.

set -euo pipefail

# Regex source: repo-root `constraints.yaml` (preferred) or fallback defaults (legacy repos).
# - Forbidden suffix patterns: `code_canonicality.forbidden_suffixes.patterns`
# - Scratchpad directories: `code_canonicality.scratchpad_directories.paths`
#
# This hook must run on bare macOS (bash 3.2). Do not add non-default deps (e.g., yq).
DEFAULT_FORBIDDEN_SUFFIX_RE='(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated|_archive|_save|V[0-9]+|New|Old|Legacy|Deprecated|Backup)(\.|/|$)'
DEFAULT_SCRATCH_DIR_RE='(^|/)(tmp|scratch|backup|_old|deprecated|archive|wip)(/|$)'

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
constraints_file="$repo_root/constraints.yaml"

yaml_get() {
  local path="${1:?yaml path required}"
  local file="${2:?yaml file required}"

  [ -f "$file" ] || return 1

  case "$path" in
    code_canonicality.forbidden_suffixes.patterns)
      sed -n '/^code_canonicality:/,/^size_limits:/p' "$file" \
        | sed -n '/^  forbidden_suffixes:/,/^  scratchpad_directories:/p' \
        | grep -E '^[[:space:]]*-[[:space:]]*' \
        | sed -E "s/^[[:space:]]*-[[:space:]]*//; s/[[:space:]]*$//; s/^[\\\"']//; s/[\\\"']$//"
      ;;
    code_canonicality.scratchpad_directories.paths)
      sed -n '/^code_canonicality:/,/^size_limits:/p' "$file" \
        | sed -n '/^  scratchpad_directories:/,/^size_limits:/p' \
        | grep -m 1 -E '^[[:space:]]*paths:' \
        | sed -E 's/^[[:space:]]*paths:[[:space:]]*//; s/[[:space:]]*$//'
      ;;
    *)
      return 1
      ;;
  esac
}

FORBIDDEN_SUFFIX_RE="$DEFAULT_FORBIDDEN_SUFFIX_RE"
SCRATCH_DIR_RE="$DEFAULT_SCRATCH_DIR_RE"
forbidden_source="fallback"
scratch_source="fallback"

if [ -f "$constraints_file" ]; then
  forbidden_joined=""
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    pat="${pat%\$}"
    if [ -z "$forbidden_joined" ]; then
      forbidden_joined="$pat"
    else
      forbidden_joined="$forbidden_joined|$pat"
    fi
  done <<EOF
$(yaml_get 'code_canonicality.forbidden_suffixes.patterns' "$constraints_file" 2>/dev/null || true)
EOF

  if [ -n "$forbidden_joined" ]; then
    # Convert identifier-style patterns (often `$`-anchored) into a path-component check.
    FORBIDDEN_SUFFIX_RE="(${forbidden_joined})(\\.|/|$)"
    forbidden_source="constraints.yaml"
  fi

  scratch_paths_line="$(yaml_get 'code_canonicality.scratchpad_directories.paths' "$constraints_file" 2>/dev/null || true)"
  if [ -n "$scratch_paths_line" ]; then
    scratch_cleaned="$(printf '%s' "$scratch_paths_line" | sed -E "s/^[[:space:]]*\\[//; s/\\][[:space:]]*$//; s/[\\\"']//g; s/,/ /g")"
    scratch_joined=""
    for term in $scratch_cleaned; do
      term="${term#/}"
      term="${term%/}"
      [ -z "$term" ] && continue
      if [ -z "$scratch_joined" ]; then
        scratch_joined="$term"
      else
        scratch_joined="$scratch_joined|$term"
      fi
    done
    if [ -n "$scratch_joined" ]; then
      SCRATCH_DIR_RE="(^|/)(${scratch_joined})(/|$)"
      scratch_source="constraints.yaml"
    fi
  fi
fi

echo "check-naming.sh: FORBIDDEN_SUFFIX_RE source: $forbidden_source" >&2
echo "check-naming.sh: SCRATCH_DIR_RE source:    $scratch_source" >&2

# Path-argument mode (agent write-time check): validate one path directly
# instead of reading the staged index.
if [ "$#" -gt 0 ]; then
  f="$1"
  if [[ "$f" =~ $FORBIDDEN_SUFFIX_RE ]] || [[ "$f" =~ $SCRATCH_DIR_RE ]]; then
    echo "naming violation (write-time): $f — see AGENTS.md § Code Canonicality" >&2
    exit 2
  fi
  exit 0
fi

# Read added or renamed files (cached).
# Avoid `mapfile` so the script works on macOS default bash 3.2 as well as bash 4+.
violations=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ $FORBIDDEN_SUFFIX_RE ]]; then
    violations+=("  forbidden naming suffix: $f")
  fi
  if [[ "$f" =~ $SCRATCH_DIR_RE ]]; then
    violations+=("  scratchpad directory:    $f")
  fi
done < <(git diff --cached --name-only --diff-filter=AR 2>/dev/null || true)

if [ "${#violations[@]}" -gt 0 ]; then
  cat <<EOF
Code canonicality violation — these path(s) cannot be committed:

$(printf '%s\n' "${violations[@]}")

Why: parallel versions (_v1, _v2, _new), placeholder names (_temp, _copy), and
scratchpad directories cause the codebase to bloat with duplicate logic.

What to do:
  - If you are refactoring: rename the new file over the old one and let git track the change in history.
  - If this is genuinely a separate concept: rename to something descriptive (no suffix).
  - If this is throwaway exploration: keep it outside the repo (e.g., /tmp).

See AGENTS.md § Code Canonicality for the full rule.
EOF
  exit 1
fi

exit 0
```

Note: eng-init must not leave root-level `.bak.*`, `_backup`, `_old`, or copy artifacts in the repository. If the user explicitly requests a destructive replacement backup, write it under `.eng-init/backups/<UTC>/` and list it in the final report; do not loosen this guard to tolerate root backup files.

---

## § Pre-commit hooks

Hook installers never clobber user state: respect an existing `core.hooksPath`, preserve hand-written hooks (append or chain, don't overwrite), and make installation idempotent.

### Variant A — Husky (Node ecosystem)

Path: `.husky/pre-commit`

```bash
#!/usr/bin/env sh
# (husky v9: hooks are plain scripts; the old husky.sh sourcing line is deprecated and removed in v10)

# Code canonicality — naming and scratchpad guard
bash .git-hooks/check-naming.sh

# Stack-specific lint+format on changed files
npx lint-staged
```

Plus add to `package.json`:

```json
"lint-staged": {
  "*.{ts,tsx,js,jsx}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml}": ["prettier --write"]
},
"scripts": {
  "prepare": "husky"
}
```

### Variant B — pre-commit framework (Python and polyglot)

<!-- eng-init template version: 2026-05-13 -->

Path: `.pre-commit-config.yaml`

```yaml
repos:
  - repo: local
    hooks:
      - id: code-canonicality-naming
        name: Code canonicality — naming and scratchpad guard
        entry: bash .git-hooks/check-naming.sh
        language: system
        pass_filenames: false
        stages: [pre-commit]

  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-merge-conflict
      - id: check-added-large-files
        args: [--maxkb=500]
      - id: detect-private-key

{{IF_PYTHON}}
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.6.9
    hooks:
      - id: ruff
        args: [--fix]
      - id: ruff-format
{{END_IF}}

{{IF_RUST}}
  - repo: local
    hooks:
      - id: cargo-fmt
        name: cargo fmt
        entry: cargo fmt --
        language: system
        types: [rust]
      - id: cargo-clippy
        name: cargo clippy
        entry: cargo clippy --all-targets --all-features -- -D warnings
        language: system
        types: [rust]
        pass_filenames: false
{{END_IF}}

{{IF_GO}}
  - repo: local
    hooks:
      - id: gofumpt
        name: gofumpt
        entry: gofumpt -l -w
        language: system
        types: [go]
      - id: golangci-lint
        name: golangci-lint
        entry: golangci-lint run --fix
        language: system
        types: [go]
        pass_filenames: false
{{END_IF}}
```

### Variant C — git-native hook (minimal, polyglot, no framework)

Path: `.git-hooks/pre-commit` (must run `git config core.hooksPath .git-hooks` after writing)

```bash
#!/usr/bin/env bash
set -euo pipefail
bash "$(dirname "$0")/check-naming.sh"
# Add stack-specific checks here.
```

Choose the variant that matches the user's primary stack. Default: variant A for Node, variant B for everything else.

---

## § Commit linting

Use a stack-native commit message checker. Do not add Node-only `commitlint` to non-Node repos.

### JavaScript / TypeScript — commitlint

Path: `commitlint.config.cjs` (the `.cjs` extension is required: the Node skeleton sets `"type": "module"`, under which a `.js` file with `module.exports` throws on load)

```js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'ci', 'build', 'perf'],
    ],
    'subject-case': [2, 'always', 'sentence-case'],
    'subject-max-length': [2, 'always', 72],
    'body-leading-blank': [2, 'always'],
  },
};
```

Add commit-msg hook (Husky):

```bash
# .husky/commit-msg
#!/usr/bin/env sh
npx --no-install commitlint --edit "$1"
```

(No `husky.sh` sourcing line: it is deprecated in husky v9 — the skeleton's own pin — and removed in v10.)

### Go / Rust / Java — git-native conventional commit hook

Path: `.git-hooks/commit-msg` (chmod +x after writing; requires `git config core.hooksPath .git-hooks` if not using Husky/pre-commit).

```bash
#!/usr/bin/env bash
set -euo pipefail

msg_file="${1:?commit message file required}"
subject="$(sed -n '1p' "$msg_file")"

if ! printf '%s' "$subject" | grep -Eq '^(feat|fix|refactor|chore|docs|test|ci|build|perf)(\([a-z0-9._/-]+\))?!?: .{1,72}$'; then
  cat <<'EOF'
Commit message must use Conventional Commits:
  type(scope): Subject under 72 chars

Allowed types: feat, fix, refactor, chore, docs, test, ci, build, perf
Example: fix(api): Reject empty refund ids
EOF
  exit 1
fi
```

### Python — commitizen

Path: `pyproject.toml` snippet.

```toml
[tool.commitizen]
name = "cz_conventional_commits"
tag_format = "v$version"
version_scheme = "pep440"
version_provider = "pep621"
update_changelog_on_bump = true
major_version_zero = true
```

Path: `.git-hooks/commit-msg` (chmod +x after writing; requires `git config core.hooksPath .git-hooks`).

```bash
#!/usr/bin/env bash
set -euo pipefail
cz check --commit-msg-file "${1:?commit message file required}"
```

---

## § Commit template

Path: `.gitmessage` (and `git config commit.template .gitmessage`)

```
# <type>(<scope>): <subject>
#
# Allowed types: feat, fix, refactor, chore, docs, test, ci, build, perf
# Scope: module / package name
# Subject: <72 chars, sentence case, no trailing period
#
# Body (optional, wrap at 72): WHY this change, not what.
# Reference issues with: Refs #123, Fixes #456.
#
# Breaking change marker: prefix a line with "BREAKING CHANGE:"
#
# Agent co-authorship:
# Co-authored-by: Agent Name <agent@example.org>
```

---

## § Editor config

Path: `.editorconfig`

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

{{IF_PYTHON}}
[*.py]
indent_size = 4
{{END_IF}}

{{IF_GO}}
[*.go]
indent_style = tab
{{END_IF}}

[Makefile]
indent_style = tab

[*.md]
trim_trailing_whitespace = false
```

---

## § Dev entry — justfile

<!-- eng-init template version: 2026-05-13 -->

Default. Adjust commands to match the chosen stack.

```just
# justfile — unified development entry point.
# Run `just` to see all available commands.

set shell := ["bash", "-cu"]

default:
    @just --list

# === Setup ===

setup:
    {{INSTALL_CMD}}

# === Daily development ===

dev:
    {{DEV_CMD}}

check: fmt-check lint typecheck test
    @echo "All checks passed."

# Canonical definition — the L2+ runtime block from agent-harness-templates must NOT redefine check-fast; {{CHECK_FAST_CMD}} values come from its per-stack table.
# Changed-scope checks for the iterate loop; run full `check` before PR.
check-fast:
    {{CHECK_FAST_CMD}}

fmt:
    {{FMT_WRITE_CMD}}

fmt-check:
    {{FMT_CHECK_CMD}}

lint:
    {{LINT_CMD}}

typecheck:
    {{TYPECHECK_CMD}}

# === Tests ===

test: test-unit test-integration

test-unit:
    {{UNIT_TEST_CMD}}

test-integration:
    {{INTEGRATION_TEST_CMD}}

test-coverage:
    {{COVERAGE_CMD}}

# === Build ===

build:
    {{BUILD_CMD}}

# === Hygiene (conditional — targets render only when matching tool is in the Stage 4 write set) ===

deps-audit:
    {{DEPS_AUDIT_CMD}}
{{IF_DEAD_CODE_TOOL}}
dead-code:
    {{DEAD_CODE_CMD}}
{{END_IF}}
{{IF_DUPLICATE_CODE_TOOL}}
duplicate-code:
    {{DUPLICATE_CODE_CMD}}
{{END_IF}}
{{IF_ANTI_DRIFT_TOOLS}}
anti-drift: dead-code duplicate-code
    @echo "anti-drift checks passed."
{{END_IF}}

clean:
    {{CLEAN_CMD}}

# L2+: runtime verification targets (dev-bg/dev-stop/dev-status/logs/smoke/e2e/verify-ui/db-reset/seed/test-guardrails) are appended here from references/agent-harness-templates.md § Runtime command block.
```

### Per-stack command substitutions

Size and complexity gates must render thresholds from `constraints.yaml` fields `max_file_lines` and `max_complexity` (defaults: 900 and 20). Circular dependency gates must honor `constraints.yaml` field `no_circular_dependencies` (default: true).

| Stack | INSTALL_CMD | DEV_CMD | FMT_WRITE_CMD | LINT_CMD | UNIT_TEST_CMD | BUILD_CMD | DUPLICATE_CODE_CMD | FILE_SIZE_CHECK_COMMAND | CIRCULAR_DEP_CHECK_COMMAND |
|-------|------------|---------|---------------|----------|---------------|-----------|--------------------|-------------------------|----------------------------|
| Node/TS | `pnpm install --frozen-lockfile` | `pnpm dev` | `pnpm prettier --write .` | `pnpm eslint . --max-warnings 0` | `pnpm vitest run` | `pnpm build` | `pnpm jscpd --threshold {{DUPLICATE_THRESHOLD}}` | `pnpm eslint . --rule "max-lines: [error, { max: {{MAX_FILE_LINES}}, skipBlankLines: true, skipComments: true }]" --rule "complexity: [error, {{MAX_COMPLEXITY}}]" --max-warnings 0` | `pnpm eslint . --rule "import/no-cycle: [error, { maxDepth: 1, ignoreExternal: true }]" --max-warnings 0` |
| Python (poetry) | `poetry install --sync` | `poetry run python -m {{APP}}` | `poetry run ruff format .` | `poetry run ruff check .` | `poetry run pytest` | `poetry build` | `poetry run pylint --disable=all --enable=duplicate-code src tests` | `MAX_FILE_LINES={{MAX_FILE_LINES}}; export MAX_FILE_LINES; find src tests -name '*.py' -exec sh -c 'for f; do n=$(wc -l < "$f"); if [ "$n" -gt "$MAX_FILE_LINES" ]; then echo "$f:$n"; bad=1; fi; done; exit "${bad:-0}"' sh {} + && poetry run ruff check . --select C901,PLR0913` | `poetry run lint-imports --config pyproject.toml` |
| Python (uv) | `uv sync --frozen` | `uv run python -m {{APP}}` | `uv run ruff format .` | `uv run ruff check .` | `uv run pytest` | `uv build` | `uv run pylint --disable=all --enable=duplicate-code src tests` | `MAX_FILE_LINES={{MAX_FILE_LINES}}; export MAX_FILE_LINES; find src tests -name '*.py' -exec sh -c 'for f; do n=$(wc -l < "$f"); if [ "$n" -gt "$MAX_FILE_LINES" ]; then echo "$f:$n"; bad=1; fi; done; exit "${bad:-0}"' sh {} + && uv run ruff check . --select C901,PLR0913` | `uv run lint-imports --config pyproject.toml` |
| Go | `go mod download` | `go run ./cmd/{{APP}}` | `gofumpt -l -w .` | `golangci-lint run --fix` | `go test ./... -race` | `go build ./...` | `dupl -threshold 100 .` | `MAX_FILE_LINES={{MAX_FILE_LINES}}; export MAX_FILE_LINES; find . -name '*.go' -not -path './vendor/*' -exec sh -c 'for f; do n=$(wc -l < "$f"); if [ "$n" -gt "$MAX_FILE_LINES" ]; then echo "$f:$n"; bad=1; fi; done; exit "${bad:-0}"' sh {} + && golangci-lint run --enable=funlen --enable=gocyclo` | `go test ./... && golangci-lint run --enable=depguard` |
| Rust | `cargo fetch` | `cargo run` | `cargo fmt` | `cargo clippy --all-targets --all-features -- -D warnings` | `cargo nextest run` | `cargo build --release` | `echo "No Rust duplicate-code gate selected; see AGENTS.md for manual review trade-off"` | `MAX_FILE_LINES={{MAX_FILE_LINES}}; export MAX_FILE_LINES; find . -name '*.rs' -not -path './target/*' -exec sh -c 'for f; do n=$(wc -l < "$f"); if [ "$n" -gt "$MAX_FILE_LINES" ]; then echo "$f:$n"; bad=1; fi; done; exit "${bad:-0}"' sh {} + && cargo clippy --all-targets --all-features -- -D warnings -W clippy::too_many_lines -W clippy::cognitive_complexity` | `cargo check --all-targets --all-features && cargo modules dependencies --all-features --no-externs` |
| Java (gradle) | `./gradlew dependencies` | `./gradlew bootRun` | `./gradlew spotlessApply` | `./gradlew check` | `./gradlew test` | `./gradlew build` | `./gradlew pmdCpdCheck` | `MAX_FILE_LINES={{MAX_FILE_LINES}}; export MAX_FILE_LINES; find src -name '*.java' -exec sh -c 'for f; do n=$(wc -l < "$f"); if [ "$n" -gt "$MAX_FILE_LINES" ]; then echo "$f:$n"; bad=1; fi; done; exit "${bad:-0}"' sh {} + && ./gradlew checkstyleMain pmdMain` | `./gradlew pmdMain test --tests "*ArchUnitTest"` |

---

## § Dev entry — Makefile fallback

<!-- eng-init template version: 2026-05-13 -->

Identical contract but Makefile-flavoured. Use when the team already has a Makefile or refuses to install `just`.

At L2+, also append a `check-fast` target and the runtime verification targets from `references/agent-harness-templates.md` § Runtime command block, translated to the selected entry-point syntax.

```makefile
.PHONY: setup dev check check-fast fmt fmt-check lint typecheck test test-unit test-integration build clean{{IF_DEAD_CODE_TOOL}} dead-code{{END_IF}}{{IF_DUPLICATE_CODE_TOOL}} duplicate-code{{END_IF}}{{IF_ANTI_DRIFT_TOOLS}} anti-drift{{END_IF}}

default: check

setup:
	{{INSTALL_CMD}}

dev:
	{{DEV_CMD}}

check: fmt-check lint typecheck test
	@echo "All checks passed."

# Changed-scope checks for the iterate loop; run full `check` before PR.
# WARNING: When substituting {{CHECK_FAST_CMD}} into a Makefile, escape every `$` as `$$`
# (Make consumes single `$`); the table values in agent-harness-templates are justfile/shell form.
# Example: `$changed` → `$$changed`, `$(git diff ...)` → `$$(git diff ...)`.
check-fast:
	{{CHECK_FAST_CMD}}

fmt:
	{{FMT_WRITE_CMD}}

fmt-check:
	{{FMT_CHECK_CMD}}

lint:
	{{LINT_CMD}}

typecheck:
	{{TYPECHECK_CMD}}

test: test-unit test-integration

test-unit:
	{{UNIT_TEST_CMD}}

test-integration:
	{{INTEGRATION_TEST_CMD}}

build:
	{{BUILD_CMD}}
{{IF_DEAD_CODE_TOOL}}
dead-code:
	{{DEAD_CODE_CMD}}
{{END_IF}}
{{IF_DUPLICATE_CODE_TOOL}}
duplicate-code:
	{{DUPLICATE_CODE_CMD}}
{{END_IF}}
{{IF_ANTI_DRIFT_TOOLS}}
anti-drift: dead-code duplicate-code
	@echo "anti-drift checks passed."
{{END_IF}}

clean:
	{{CLEAN_CMD}}
```

---


## § Dev entry — package.json scripts

<!-- eng-init template version: 2026-06-11 -->

Use when Q5.1 selects package scripts as the unified entry point. Merge these keys into an existing `package.json` or the Node skeleton below; do not create a parallel `justfile`/`Makefile` just to satisfy AGENTS.md. At L2+, also add the runtime verification scripts from `references/agent-harness-templates.md` § Runtime command block using the same naming style.

```json
{
  "scripts": {
    "setup": "{{INSTALL_CMD}}",
    "dev": "{{DEV_CMD}}",
    "check": "{{FMT_CHECK_CMD}} && {{LINT_CMD}} && {{TYPECHECK_CMD}} && {{UNIT_TEST_CMD}} && {{INTEGRATION_TEST_CMD}} && {{BUILD_CMD}}",
    "check:fast": "{{CHECK_FAST_CMD}}",
    "fmt": "{{FMT_WRITE_CMD}}",
    "fmt:check": "{{FMT_CHECK_CMD}}",
    "lint": "{{LINT_CMD}}",
    "typecheck": "{{TYPECHECK_CMD}}",
    "test": "{{UNIT_TEST_CMD}}",
    "test:unit": "{{UNIT_TEST_CMD}}",
    "test:integration": "{{INTEGRATION_TEST_CMD}}",
    "build": "{{BUILD_CMD}}",
    "clean": "{{CLEAN_CMD}}"{{IF_DEAD_CODE_TOOL}},
    "dead-code": "{{DEAD_CODE_CMD}}"{{END_IF}}{{IF_DUPLICATE_CODE_TOOL}},
    "duplicate-code": "{{DUPLICATE_CODE_CMD}}"{{END_IF}}{{IF_ANTI_DRIFT_TOOLS}},
    "anti-drift": "{{DEAD_CODE_CMD}} && {{DUPLICATE_CODE_CMD}}"{{END_IF}}
  }
}
```

For pnpm/yarn repos, render AGENTS.md command placeholders as `pnpm <script>` / `yarn <script>` (or `pnpm run <script>` / `yarn run <script>` when required by the team convention). Stage 4 must verify the rendered script names exist in `package.json`.

---
## § CI workflow

<!-- eng-init template version: 2026-05-13 -->

Path: `.github/workflows/ci.yml`. Risk-layered template.

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

permissions:
  contents: read

jobs:
  layer1-fast-checks:
    name: Fast checks (fmt + lint + typecheck)
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      {{SETUP_STEPS}}
      - run: {{FMT_CHECK_CMD}}
      - run: {{LINT_CMD}}
      - run: {{TYPECHECK_CMD}}

  layer2-unit-tests:
    name: Unit tests
    needs: layer1-fast-checks
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      {{SETUP_STEPS}}
      - run: {{UNIT_TEST_CMD}}
      - name: Upload coverage
        uses: codecov/codecov-action@v4
        if: success()

  layer3-integration-tests:
    name: Integration tests
    needs: layer2-unit-tests
    runs-on: ubuntu-latest
    timeout-minutes: 20
    if: contains(github.event.pull_request.labels.*.name, 'skip-integration') == false
    services:
      {{LOCAL_SERVICES_SECTION_IF_NEEDED}}
    steps:
      - uses: actions/checkout@v4
      {{SETUP_STEPS}}
      - run: {{INTEGRATION_TEST_CMD}}

  layer4-anti-drift:
    name: Anti-drift (duplicate + dead code + size + cycles)
    needs: layer1-fast-checks
    runs-on: ubuntu-latest
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@v4
      {{SETUP_STEPS}}
      - name: Verify constraints.yaml consistency
        run: |
          # Check that naming guard uses constraints.yaml as source (not hardcoded)
          grep -q 'constraints\.yaml' .git-hooks/check-naming.sh || echo "WARNING: naming guard may hardcode regex"
      - name: Duplicate code
        run: |
          {{DUPLICATE_CODE_CMD}}
      - name: Dead code
        run: |
          {{DEAD_CODE_CMD}}
      - name: File size audit
        run: |
          {{FILE_SIZE_CHECK_COMMAND}}
      - name: Circular dependency check
        run: |
          {{CIRCULAR_DEP_CHECK_COMMAND}}

  layer5-secret-scan:
    name: Secret scan
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  # Include this job only at strictness profile L3/L4 (constraints.yaml
  # size_limits.max_pr_diff_lines severity = block). At L2 the limit is
  # review-only via the PR template; do not pretend otherwise.
  layer6-diff-size-guard:
    name: PR diff size guard
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Enforce max PR diff lines
        if: ${{ !contains(github.event.pull_request.labels.*.name, 'diff-limit-exempt') }}
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: |
          MAX_DIFF_LINES=$(python3 - <<'PY'
          import pathlib
          import re

          text = pathlib.Path("constraints.yaml").read_text()
          match = re.search(r"(?ms)^  max_pr_diff_lines:\n    value: (\d+)\n", text)
          if not match:
              raise SystemExit("Could not read size_limits.max_pr_diff_lines from constraints.yaml")
          print(match.group(1))
          PY
          )
          LINES=$(git diff --diff-filter=ACMR --ignore-all-space "$BASE_SHA"...HEAD -- . \
            ':(exclude)*.lock' ':(exclude)**/package-lock.json' ':(exclude)**/pnpm-lock.yaml' \
            ':(exclude)**/__snapshots__/**' | grep -c '^[+-][^+-]' || true)
          echo "Changed lines (excluding lockfiles/snapshots): $LINES (limit: $MAX_DIFF_LINES)"
          if [ "$LINES" -gt "$MAX_DIFF_LINES" ]; then
            echo "::error::PR exceeds the ${MAX_DIFF_LINES}-line diff limit. Split it, or add the 'diff-limit-exempt' label with a justification in the PR description."
            exit 1
          fi

  # Branch protection requires ONLY this check. GitHub treats a skipped
  # required check as PASSING, so if a dependency failure caused this job to
  # be skipped, branch protection would be silently disabled. `if: always()`
  # is load-bearing: it guarantees this job runs and inspects every result.
  all-checks-passed:
    name: All checks passed
    if: always()
    needs:
      - layer1-fast-checks
      - layer2-unit-tests
      - layer3-integration-tests
      - layer4-anti-drift
      - layer5-secret-scan
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Fail on any failed, cancelled, or skipped required job
        env:
          NEEDS: ${{ toJSON(needs) }}
        run: |
          echo "$NEEDS"
          if echo "$NEEDS" | grep -Eq '"result": "(failure|cancelled|skipped)"'; then
            echo "::error::A required job failed, was cancelled, or was skipped. Skipped counts as failure here because GitHub counts a skipped required check as passing."
            exit 1
          fi
```

Notes:
- The `concurrency` block cancels in-flight runs when a PR is force-pushed; main branch runs are not cancelled.
- **Branch protection points at the single `All checks passed` check**, never at individual jobs. Listing jobs individually reintroduces the skipped-check hole and forces a settings edit every time a job is added or renamed.
- The aggregator treats `skipped` as failure by design. This conflicts with job-level `if:` skips on required jobs (`layer3`'s `skip-integration` label): at L3/L4, drop the label `if:` — integration evidence is not label-optional; at L2, if the team keeps the label workflow, remove `layer3-integration-tests` from the aggregator's `needs` and accept that integration evidence is label-optional. Never whitelist skips inside the aggregator itself — an aggregator that excuses skips re-opens the hole it exists to close.
- `layer6-diff-size-guard` is intentionally outside the aggregator's `needs`: it ships only at L3/L4 and only on `pull_request` events, so on push builds it would always report skipped.
- `permissions: contents: read` is the principle of least privilege — escalate per-job if a job needs more.
- Workflows that consume secrets never use `pull_request_target` (it runs untrusted PR code with secret access — a known leak vector). Gate secret-consuming jobs on trusted events and exclude fork/Dependabot PRs at job level; pair with the preflight in `references/agent-harness-templates.md` § Secret preflight.
- Adjust the matrix (multi-OS, multi-version) per stack reality.
- `layer6-diff-size-guard` ships only at L3/L4 profiles. The `diff-limit-exempt` label skips the check; exemptions require a justification in the PR description (reviewers enforce that part).
- L2+ repos append a smoke step (hurl) to `layer3-integration-tests`, and run `scripts/test-guardrails.sh` as a scheduled job. Templates for both: `references/agent-harness-templates.md`.
- The lockfile–manifest consistency check ships as a **standalone job** with its own `fetch-depth: 0` checkout (template: `references/agent-harness-templates.md` § Lockfile–manifest consistency) — do not append it to `layer1-fast-checks`; layer1's shallow checkout lacks the PR base SHA required by `git diff "$BASE_SHA"...HEAD`.

### CI setup snippets

Use these exact snippets for `{{SETUP_STEPS}}`.

#### Node / TypeScript with pnpm

```yaml
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
```

#### Go

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: "{{GO_VERSION}}"
          cache: true
      - run: go mod download
      - run: go install mvdan.cc/gofumpt@v0.7.0
      - run: go install github.com/mibk/dupl@v1.0.0
      - run: go install github.com/uudashr/gocognit/cmd/gocognit@v1.1.0
```

#### Python with uv

```yaml
      - uses: actions/setup-python@v5
        with:
          python-version: "{{PY_VERSION}}"
      - uses: astral-sh/setup-uv@v4
        with:
          enable-cache: true
      - run: uv sync --frozen --all-extras --dev
```

#### Rust

```yaml
      - uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: "{{RUST_VERSION}}"
          components: clippy,rustfmt
      - uses: Swatinem/rust-cache@v2
      - run: cargo install cargo-nextest --locked
      - run: cargo install cargo-machete --locked
```

#### Java with Gradle

```yaml
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "{{JAVA_VERSION}}"
      - uses: gradle/actions/setup-gradle@v4
```

### Local service snippets

Use this for `{{LOCAL_SERVICES_SECTION_IF_NEEDED}}` when Postgres integration tests need a CI service:

```yaml
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: app_test
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U app -d app_test"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
```

If integration tests use Testcontainers, omit `services:` and set the workflow job to run with Docker available on `ubuntu-latest`.

---

## § PR template

Path: `.github/PULL_REQUEST_TEMPLATE.md`

```markdown
## Summary

<!-- One paragraph: what changed and why. Not what files changed (the diff already shows that). -->

## Type of change

- [ ] feat — new functionality
- [ ] fix — bug fix
- [ ] refactor — internal change, no behavioural change
- [ ] chore — tooling, deps, infra
- [ ] docs — documentation only
- [ ] test — tests only

## Test plan

<!-- How was this verified? Specific commands, env, results. "I ran the tests" is not a test plan. -->

- [ ] Unit tests pass: `{{UNIT_TEST_CMD}}`
- [ ] Integration tests pass: `{{INTEGRATION_TEST_CMD}}`
- [ ] Lint and typecheck pass: `{{CHECK_CMD}}`
- [ ] Manually verified: <describe steps>

## Runtime evidence

<!-- Required: commands run + key output. For UI changes: screenshot reference.
     Provenance is part of the evidence — state next to it which tree/branch was
     serving, real vs. fixture data/keys, and which mode flags were active. An
     unattributed screenshot or transcript is not evidence.
     Binary media (GIF/screenshots) live on a dedicated orphan assets branch or
     external host, never committed to this PR's branch (media bloats every
     future clone); the assets branch is append-only — merged PR bodies
     reference its URLs forever, so never force-push or delete it.
     Only accepted escape hatch, verbatim: "None — review-only change (reason: ...)". -->

## Risk

<!-- What could break? Who is affected if it does? What's the rollback? -->

## Canonicality check

- [ ] No `_v1`/`_v2`/`_new`/`_old`/`_backup` suffixes introduced.
- [ ] No commented-out code blocks introduced.
- [ ] No `tmp/`, `scratch/`, `wip/` directories.
- [ ] If this replaces an existing implementation, the old version is deleted in this PR (not deprecated for later).

## References

<!-- Issues, ADRs, RFCs -->
```

Rule: reviewers treat a PR without a filled `## Runtime evidence` section as unverified.

---

## § Issue templates

Path: `.github/ISSUE_TEMPLATE/bug_report.md` (and `feature_request.md`, `chore.md`)

```markdown
---
name: Bug report
about: Something is broken
labels: bug
---

## What happened

## What you expected

## Steps to reproduce

1.
2.
3.

## Environment

- OS:
- Version:
- Commit / build:

## Logs / screenshots
```

---

## § Lint configs (per stack)

### TypeScript / React / Next.js — ESLint 9 flat config

<!-- eng-init template version: 2026-05-13 -->

Path: `eslint.config.mjs`. Use this when the repo uses ESLint 9 or newer. For any TypeScript stack, Stage 4's tool-rule consistency check must include either `eslint.config.mjs` or `.eslintrc.json` in the write set.

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

// Catches both snake_case (`auth_v2`, `auth_new`) and PascalCase (`AuthV2`, `AuthNew`) drift —
// PascalCase form is common in React component / TypeScript class identifiers.
// Pattern source: constraints.yaml → code_canonicality.forbidden_suffixes.patterns
// Keep these in sync. CI layer4 verifies consistency.
const forbiddenVersionSuffix = '(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated|V[0-9]+|New|Old|Backup|Temp|Copy|Final|Real|Improved|Refactored|Fixed|Legacy|Deprecated)$';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'reports/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      import: importPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      '@next/next': nextPlugin,
    },
    settings: {
      react: { version: 'detect' },
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Size discipline — values from constraints.yaml size_limits (profile-resolved).
      // Severity: 'warn' at L1, 'error' at L2+.
      'max-lines': ['{{SIZE_RULE_SEVERITY}}', { max: {{MAX_FILE_LINES}}, skipBlankLines: true, skipComments: true }],
      complexity: ['{{SIZE_RULE_SEVERITY}}', {{MAX_COMPLEXITY}}],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'default',
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'forbid',
          custom: { regex: forbiddenVersionSuffix, match: false },
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
          custom: { regex: forbiddenVersionSuffix, match: false },
        },
        {
          selector: 'objectLiteralProperty',
          format: null,
          custom: { regex: forbiddenVersionSuffix, match: false },
        },
      ],
      'import/no-cycle': ['error', { maxDepth: 1, ignoreExternal: true }],
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './features', from: './app', message: 'Feature modules must not import Next app routes.' },
            { target: './components', from: './app', message: 'Shared components must not import route modules.' },
            { target: './lib/server', from: './components', message: 'Client-safe components must not import server-only modules.' },
          ],
        },
      ],
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
);
```

### TypeScript / React / Next.js — ESLint 8 classic fallback

<!-- eng-init template version: 2026-05-13 -->

Path: `.eslintrc.json`. Use this only when the repo is still on ESLint 8 or older.

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "project": true,
    "tsconfigRootDir": "."
  },
  "plugins": ["@typescript-eslint", "import", "react", "react-hooks", "@next/next"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/strict-type-checked",
    "plugin:@typescript-eslint/stylistic-type-checked",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
    "plugin:@next/next/recommended",
    "plugin:@next/next/core-web-vitals",
    "prettier"
  ],
  "settings": {
    "react": { "version": "detect" },
    "import/resolver": {
      "typescript": true,
      "node": true
    }
  },
  "ignorePatterns": [".next/", "coverage/", "dist/", "node_modules/", "playwright-report/", "reports/"],
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unnecessary-type-assertion": "error",
    "@typescript-eslint/consistent-type-imports": ["error", { "prefer": "type-imports" }],
    "max-lines": ["{{SIZE_RULE_SEVERITY}}", { "max": {{MAX_FILE_LINES}}, "skipBlankLines": true, "skipComments": true }],
    "complexity": ["{{SIZE_RULE_SEVERITY}}", {{MAX_COMPLEXITY}}],
    "@typescript-eslint/naming-convention": [
      "error",
      {
        "selector": "default",
        "format": ["camelCase", "PascalCase", "UPPER_CASE"],
        "leadingUnderscore": "allow",
        "trailingUnderscore": "forbid",
        "custom": {
          "regex": "(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated)$",
          "match": false
        }
      },
      {
        "selector": "typeLike",
        "format": ["PascalCase"],
        "custom": {
          "regex": "(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated)$",
          "match": false
        }
      },
      {
        "selector": "objectLiteralProperty",
        "format": null,
        "custom": {
          "regex": "(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated)$",
          "match": false
        }
      }
    ],
    "import/no-cycle": ["error", { "maxDepth": 1, "ignoreExternal": true }],
    "import/no-restricted-paths": [
      "error",
      {
        "zones": [
          { "target": "./features", "from": "./app", "message": "Feature modules must not import Next app routes." },
          { "target": "./components", "from": "./app", "message": "Shared components must not import route modules." },
          { "target": "./lib/server", "from": "./components", "message": "Client-safe components must not import server-only modules." }
        ]
      }
    ],
    "react/react-in-jsx-scope": "off",
    "react/prop-types": "off"
  }
}
```

### Go — golangci-lint

<!-- eng-init template version: 2026-05-13 -->

Path: `.golangci.yml`.

```yaml
run:
  timeout: 5m
  tests: true

linters:
  enable:
    - errcheck
    - funlen
    - gocognit
    - gocritic
    - gofumpt
    - gosec
    - govet
    - ineffassign
    - nilerr
    - revive
    - staticcheck
    - unused
    - wrapcheck

linters-settings:
  # Values from constraints.yaml size_limits (profile-resolved): L1=1000/30 L2=900/20 L3=800/15 L4=700/10.
  gocognit:
    min-complexity: {{MAX_COMPLEXITY}}
  funlen:
    lines: {{MAX_FUNCTION_LINES}}
    statements: -1
  gocritic:
    enabled-checks:
      - commentedOutCode
      - ifElseChain
      - sloppyReassign
      - uncheckedInlineErr
  revive:
    severity: error
```

### Python — pyproject lint sections

Add this to `pyproject.toml`.

```toml
[tool.ruff]
target-version = "py310"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM", "C4", "C90", "RET", "RUF"]

# Value from constraints.yaml size_limits (profile-resolved): L1=30 L2=20 L3=15 L4=10.
[tool.ruff.lint.mccabe]
max-complexity = {{MAX_COMPLEXITY}}

[tool.mypy]
python_version = "3.10"
strict = true
warn_unused_ignores = true
warn_redundant_casts = true

[tool.pylint."messages control"]
disable = "all"
enable = "duplicate-code"
```

### Rust — lint config

Path: `Cargo.toml` snippet.

```toml
[lints.rust]
unsafe_code = "forbid"
missing_docs = "warn"

[lints.clippy]
all = "deny"
pedantic = "warn"
nursery = "warn"
unwrap_used = "deny"
expect_used = "deny"
```

### Java — Gradle PMD/SpotBugs snippets

Path: `build.gradle.kts` snippet.

```kotlin
plugins {
    pmd
    id("com.github.spotbugs") version "6.0.26"
}

pmd {
    toolVersion = "7.6.0"
    isConsoleOutput = true
    ruleSets = listOf("category/java/bestpractices.xml", "category/java/errorprone.xml")
}

tasks.register<org.gradle.api.plugins.quality.Pmd>("pmdCpdCheck") {
    ruleSetFiles = files()
    ruleSets = listOf()
    source = fileTree("src/main/java")
}
```

---

## § TS toolchain configs

When the stack is TypeScript / React / Next.js, Stage 4 must write both `tsconfig.json` and `.prettierrc.json` in addition to `eslint.config.mjs`. AGENTS.md's Enforcement Index typically points at all three — leaving any of them out produces phantom enforcement (the lesson of the iter-1 → iter-3 regression cycle).

### `tsconfig.json`

<!-- eng-init template version: 2026-05-13 -->

Path: `tsconfig.json`. Strictness flags below are deliberate — relaxing any of them removes a layer of agent-drift defense and must be justified in the PR description.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "incremental": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "forceConsistentCasingInFileNames": true,
    "useUnknownInCatchVariables": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next", "dist", "coverage", "playwright-report"]
}
```

For non-Next.js TS projects, remove `"jsx": "preserve"` and the `next` plugin, and adjust `include`.

### `.prettierrc.json`

<!-- eng-init template version: 2026-05-13 -->

Path: `.prettierrc.json`. Keep minimal — Prettier defaults are mostly correct.

```json
{
  "$schema": "https://json.schemastore.org/prettierrc",
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always",
  "endOfLine": "lf",
  "overrides": [
    {
      "files": ["*.yml", "*.yaml"],
      "options": { "singleQuote": false }
    }
  ]
}
```

The YAML override is load-bearing: `constraints.yaml` command strings must stay double-quoted — the deterministic checker (`check_rendered_harness.py`) reads them with a double-quote contract, and a formatter that rewrites them to single quotes makes a freshly rendered repo fail its own gate.

---

## § Anti-drift configs

Anti-drift tools are per-stack. Do not add Node tools to non-Node stacks unless the user explicitly accepts Node as shared repo tooling.

### JavaScript / TypeScript

Duplicate code path: `jscpd.json`.

```json
{
  "threshold": {{DUPLICATE_THRESHOLD}},
  "reporters": ["console", "json"],
  "output": "./reports/jscpd",
  "ignore": [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/target/**",
    "**/vendor/**",
    "**/__snapshots__/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/testdata/**"
  ],
  "absolute": true,
  "gitignore": true
}
```

Dead code path: `knip.json`.

```json
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "entry": [
    "next.config.{js,mjs,ts}",
    "middleware.{ts,tsx}",
    "app/**/{page,layout,loading,error,not-found,route}.{ts,tsx}",
    "pages/**/*.{ts,tsx}",
    "src/app/**/{page,layout,loading,error,not-found,route}.{ts,tsx}",
    "src/pages/**/*.{ts,tsx}",
    "src/**/*.{test,spec}.{ts,tsx}",
    "tests/**/*.{test,spec}.{ts,tsx}",
    "playwright.config.{ts,js}"
  ],
  "project": ["**/*.{ts,tsx,js,jsx}"],
  "ignore": [
    ".next/**",
    "coverage/**",
    "dist/**",
    "node_modules/**",
    "playwright-report/**"
  ],
  "ignoreDependencies": [
    "@types/*",
    "eslint-*",
    "prettier",
    "tailwindcss"
  ]
}
```

Commands:

```bash
pnpm jscpd --threshold {{DUPLICATE_THRESHOLD}}
pnpm knip --reporter compact
pnpm eslint . --max-warnings 0
```

### Go

Commands:

```bash
dupl -threshold 100 .
golangci-lint run --enable=unused
gocognit -over {{MAX_COMPLEXITY}} .
```

`dupl -threshold 100` is a fixed token heuristic for Go duplicate detection; do not substitute `{{DUPLICATE_THRESHOLD}}` percent values directly. `unused` via `golangci-lint` handles dead code / unused identifiers. `gocognit` is not dead-code detection; it is included because repeated agent drift often shows up as high cognitive complexity before exact duplication appears.

### Python

Commands:

```bash
pylint --disable=all --enable=duplicate-code src tests
vulture src tests --min-confidence 80
ruff check .
```

Use `pylint` for duplicate-code detection, `vulture` for dead code, and `ruff` for fast lint enforcement. `pylint --enable=duplicate-code` uses its own similarity heuristic; `{{DUPLICATE_THRESHOLD}}` percent values are advisory unless the repo swaps in a percent-capable detector. If the project refuses Pylint, substitute a checked-in custom pyflakes-based duplicate scanner and document the trade-off in AGENTS.md.

### Rust

Commands:

```bash
cargo machete
cargo +nightly udeps
cargo clippy --all-targets --all-features -- -D warnings
```

Rust has good dead dependency detection (`cargo-machete`, `cargo-udeps`) but no broadly accepted lightweight duplicate-code detector. Do not pretend the trio is complete: AGENTS.md must state that Rust duplicate-code detection is manual review or delegated to SonarQube/CodeQL if the repo already uses one.

### Java

Maven commands:

```bash
mvn -B pmd:cpd-check
mvn -B dependency:analyze
mvn -B pmd:check spotbugs:check
```

Gradle commands:

```bash
./gradlew pmdCpdCheck
./gradlew dependencyAnalysis
./gradlew pmdMain spotbugsMain
```
PMD CPD is a stack-specific duplicate detector; the profile percent threshold is advisory unless the repo adds a percent-capable duplicate detector.

Wire into the selected dev entry point (`dead-code` / `anti-drift` recipe, target, or package script) and CI `layer4-anti-drift`.

---

## § Stack skeletons

### Node / Next.js `package.json`

<!-- eng-init template version: 2026-05-13 -->

Path: `package.json`. Use only for greenfield Node/TypeScript repos when no manifest exists.

```json
{
  "name": "{{PACKAGE_NAME}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.4",
  "engines": {
    "node": ">=20.11.0"
  },
  "scripts": {
    "prepare": "husky",
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "fmt": "prettier --write .",
    "fmt:check": "prettier --check .",
    "lint": "eslint . --max-warnings 0",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "e2e": "playwright test",
    "dead-code": "knip --reporter compact",
    "duplicate-code": "jscpd --threshold {{DUPLICATE_THRESHOLD}}"
  },
  "lint-staged": {
    "*.{ts,tsx,js,jsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml,yaml,css}": ["prettier --write"]
  },
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@commitlint/cli": "^19.6.0",
    "@commitlint/config-conventional": "^19.6.0",
    "@eslint/js": "^9.17.0",
    "@next/eslint-plugin-next": "^14.2.0",
    "@playwright/test": "^1.49.0",
    "@types/node": "^20.17.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@typescript-eslint/eslint-plugin": "^8.18.0",
    "@typescript-eslint/parser": "^8.18.0",
    "eslint": "^9.17.0",
    "eslint-config-prettier": "^9.1.0",
    "eslint-import-resolver-typescript": "^3.7.0",
    "eslint-plugin-import": "^2.31.0",
    "eslint-plugin-react": "^7.37.0",
    "eslint-plugin-react-hooks": "^5.1.0",
    "globals": "^15.14.0",
    "husky": "^9.1.0",
    "jscpd": "^4.0.5",
    "knip": "^5.40.0",
    "lint-staged": "^15.2.0",
    "prettier": "^3.4.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.18.0",
    "vitest": "^2.1.0"
  }
}
```

Coverage thresholds for the TS stack (render per-file at L3/L4; repo-wide is acceptable at L1/L2):

```ts
// vitest.config.ts — coverage excerpt. `perFile: true` so a well-covered big
// file cannot subsidize a bare one. Value from constraints.yaml
// testing.min_line_coverage; every exclude entry needs a reason and
// an exit condition in constraints.yaml `exemptions`.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: { perFile: true, lines: {{COVERAGE_PERCENT}}, branches: {{COVERAGE_PERCENT}}, functions: {{COVERAGE_PERCENT}}, statements: {{COVERAGE_PERCENT}} },
    },
  },
})
```

Per-file equivalents on other stacks: Python — `coverage report --fail-under={{COVERAGE_PERCENT}}` per package, or a short script over `coverage json` asserting each file; Go — per-package threshold script over `go test -coverprofile`; Java — JaCoCo rule at `<element>CLASS</element>`. When a stack only supports a global gate, say so in AGENTS.md instead of implying per-file enforcement.

### Python `pyproject.toml`

<!-- eng-init template version: 2026-05-13 -->

Path: `pyproject.toml`. Use only for greenfield Python library/CLI repos when no manifest exists.

```toml
[project]
name = "{{PACKAGE_NAME}}"
version = "0.1.0"
description = "{{ONE_LINE_DESCRIPTION}}"
requires-python = ">=3.10"
dependencies = [
  "click>=8.1",
]

[project.scripts]
{{CLI_NAME}} = "{{MODULE_NAME}}.cli:main"

[dependency-groups]
dev = [
  "commitizen>=4.1",
  "mypy>=1.14",
  "pylint>=3.3",
  "pytest>=8.3",
  "pytest-cov>=6.0",
  "pytest-xdist>=3.6",
  "ruff>=0.8",
  "vulture>=2.14",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
addopts = "-ra --strict-markers --strict-config --cov={{MODULE_NAME}} --cov-fail-under={{COVERAGE}}"
testpaths = ["tests"]

[tool.coverage.run]
branch = true
source = ["{{MODULE_NAME}}"]

[tool.coverage.report]
show_missing = true
skip_covered = true

[tool.ruff]
target-version = "py310"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM", "C4", "C90", "RET", "RUF"]

# Value from constraints.yaml size_limits (profile-resolved): L1=30 L2=20 L3=15 L4=10.
[tool.ruff.lint.mccabe]
max-complexity = {{MAX_COMPLEXITY}}

[tool.mypy]
python_version = "3.10"
strict = true
warn_unused_ignores = true
warn_redundant_casts = true

[tool.commitizen]
name = "cz_conventional_commits"
tag_format = "v$version"
version_scheme = "pep440"
version_provider = "pep621"
update_changelog_on_bump = true
major_version_zero = true
```

---

## § Gitignore templates

### Next.js

Path: `.gitignore`.

```gitignore
node_modules/
.next/
out/
dist/
build/
coverage/
playwright-report/
test-results/
reports/
.env
.env.*
!.env.example
*.tsbuildinfo
.vercel/
.DS_Store
Thumbs.db
*.log
```

### Go

Path: `.gitignore`.

```gitignore
bin/
dist/
coverage.out
reports/
*.test
*.prof
.env
.env.*
!.env.example
.DS_Store
Thumbs.db
*.log
```

### Python

Path: `.gitignore`.

```gitignore
.venv/
__pycache__/
*.py[cod]
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
coverage.xml
htmlcov/
dist/
build/
*.egg-info/
reports/
.env
.env.*
!.env.example
.DS_Store
Thumbs.db
*.log
```

---

## § Renovate

Path: `renovate.json`.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "dependencyDashboard": true,
  "minimumReleaseAge": "{{MIN_RELEASE_AGE_DAYS}} days",
  "labels": ["dependencies"],
  "packageRules": [
    {
      "matchUpdateTypes": ["major"],
      "dependencyDashboardApproval": true,
      "labels": ["dependencies", "major"]
    },
    {
      "matchUpdateTypes": ["minor"],
      "schedule": ["before 5am on monday"],
      "labels": ["dependencies", "minor"]
    },
    {
      "matchUpdateTypes": ["patch", "pin", "digest"],
      "automerge": false,
      "labels": ["dependencies", "patch"]
    },
    {
      "matchDatasources": ["npm"],
      "rangeStrategy": "pin"
    },
    {
      "matchManagers": ["gomod"],
      "postUpdateOptions": ["gomodTidy"]
    }
  ],
  "vulnerabilityAlerts": {
    "enabled": true,
    "labels": ["security"],
    "minimumReleaseAge": null
  }
}
```

---

## § Local services

### Postgres docker compose

Path: `docker-compose.yml`. Use when local integration tests need Postgres and the project does not already have a compose file.

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: app_dev
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app_dev"]
      interval: 10s
      timeout: 5s
      retries: 5
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

---

## § Contract testing

### OpenAPI starter

Path: `schemas/openapi.yaml`.

```yaml
openapi: 3.1.0
info:
  title: "{{SERVICE_NAME}} API"
  version: "0.1.0"
paths: {}
components:
  schemas: {}
```

### Go OpenAPI snapshot test

Path: `tests/contract/openapi_snapshot_test.go`.

```go
package contract_test

import (
	"bytes"
	"os"
	"testing"
)

func TestOpenAPISnapshot(t *testing.T) {
	current, err := os.ReadFile("schemas/openapi.yaml")
	if err != nil {
		t.Fatalf("read current schema: %v", err)
	}

	snapshot, err := os.ReadFile("schemas/snapshots/openapi.yaml.snapshot")
	if err != nil {
		t.Fatalf("read schema snapshot: %v", err)
	}

	if !bytes.Equal(current, snapshot) {
		t.Fatalf("OpenAPI schema differs from snapshot; update schemas/snapshots/openapi.yaml.snapshot intentionally")
	}
}
```

Path: `schemas/snapshots/openapi.yaml.snapshot`.

```yaml
openapi: 3.1.0
info:
  title: "{{SERVICE_NAME}} API"
  version: "0.1.0"
paths: {}
components:
  schemas: {}
```

### Public API snapshot examples

TypeScript:

```bash
npm run build:types
npx api-extractor run
git diff --exit-code api/{{PKG_NAME}}.api.md
```

Python:

```bash
python -m mypy.stubtest {{PKG_NAME}}
python -m pytest tests/contract/test_public_api.py
git diff --exit-code api/{{PKG_NAME}}.api.md
```

Go:

```bash
go doc ./... > api/{{MODULE_NAME}}.api.md
gorelease ./...
git diff --exit-code api/{{MODULE_NAME}}.api.md
```

Rust:

```bash
cargo public-api > api/{{CRATE_NAME}}.api.md
cargo semver-checks
git diff --exit-code api/{{CRATE_NAME}}.api.md
```

Java:

```bash
mvn -q revapi:check
mvn -q javadoc:javadoc
git diff --exit-code api/{{ARTIFACT_ID}}.api.md
```

---

## § constraints.yaml

Path: `constraints.yaml`. See `references/constraints-yaml-template.md` for the full template.

Always write this file in Stage 4. It is the machine-readable single source of truth for every numeric threshold and regex pattern declared in AGENTS.md. CI scripts should `yq`-parse this file rather than hardcoding values.

### Why a separate YAML (not just AGENTS.md)

- CI jobs consume structured data, not prose.
- Changing a threshold updates one file instead of N.
- New tools can read constraints without parsing markdown.
- AGENTS.md remains the human-and-agent constitution; `constraints.yaml` is the machine-consumable supplement.

---

## § Decision records (conditional — Q6.8 yes)

<!-- eng-init template version: 2026-08-02 -->

Minimal decision-record module for agent-heavy repos. Not full ADR ceremony: one file per decision, folder state is the lifecycle, and the one non-negotiable section is **Alternatives considered** — recording a decision without recording what it beat invites re-debate, which is the failure this module exists to prevent.

`decisions/README.md`:

```markdown
# Decision records

One file per non-trivial decision: `decisions/YYYY-MM-DD-topic.md`. Written in the same PR as the change it explains.

Rules:
- `## Alternatives considered` is mandatory — alternatives are recorded, never invented after the fact.
- A decision is superseded by a NEW record cross-linked both ways; never edit an old record into its opposite.
- Update stale facts (paths, names, defaults) in place when code changes them; the decision and its rationale stay as written.
- No index file: the directory listing is the index.
```

`decisions/TEMPLATE.md`:

```markdown
# <decision title>

Status: active | superseded by <file>

## Problem

<what forced a choice>

## Decision

<present tense, what is now true>

## Alternatives considered

- **<alternative>** — <why it lost>

## Consequences

<costs accepted, risks, follow-ups>
```

## § Release workflow

### Python PyPI trusted publishing

Path: `.github/workflows/release.yml`.

```yaml
name: Release

on:
  workflow_dispatch:
  push:
    branches: [main]

permissions:
  contents: write
  id-token: write

jobs:
  release:
    runs-on: ubuntu-latest
    environment: pypi
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - uses: astral-sh/setup-uv@v4
      - run: uv sync --frozen --all-extras --dev
      - run: uv build
      - name: Publish to PyPI
        if: github.event_name == 'workflow_dispatch'
        run: uv publish --trusted-publishing automatic
```

---

## § Substitution checklist (Stage 4)

Before writing any file:

0. Resolve every profile-derived placeholder from the Q1.4 Strictness Profile table for the chosen profile: `{{MAX_FILE_LINES}}`, `{{MAX_COMPLEXITY}}`, `{{COVERAGE_PERCENT}}`, `{{DUPLICATE_THRESHOLD}}`, and all severity placeholders (`{{SIZE_RULE_SEVERITY}}` → `warn` at L1 / `error` at L2+, `{{SIZE_SEVERITY}}`/`{{ANTI_DRIFT_SEVERITY}}` → `warn` at L1 / `block` at L2+, `{{PR_DIFF_SEVERITY}}`). Any value weaker than the profile column must already be a confirmed downgrade in the ledger.
1. Walk the eng-init placeholder list. Substitute every unresolved upper-snake placeholder (`{{PLACEHOLDER}}`) with a concrete value from the decision ledger; preserve lowercase runtime placeholders in generated consumer files and GitHub Actions `${{ ... }}` expressions.
2. If any eng-init placeholder lacks a value, **stop and ask the user**. Do not invent values.
3. Run the Stage 4 tool-rule consistency check from `SKILL.md`: every tool named in AGENTS.md must have its concrete config or hook in the write set. For TypeScript/React/Next.js, an ESLint config is required: `eslint.config.mjs` for ESLint 9+ or `.eslintrc.json` for ESLint 8 fallback.
4. Verify every command named in the AGENTS.md Verification Matrix resolves through the selected dev entry point (`justfile`, `Makefile`, or package.json scripts) and exists in the write set or the repo. A matrix row without a working command must be removed or the target added — no phantom verification.
5. Verify the file is syntactically valid for its language (e.g., parse YAML/JSON, shellcheck bash, run `just --evaluate`, `make -n`, or package-manager script listing as appropriate for the selected entry point).
6. For executable scripts (`.git-hooks/*.sh`, `.husky/*`), `chmod +x` after writing.
7. After all auxiliary files are written, run a final sanity command appropriate to the selected entry point (`just check`, `make check`, `npm run check` / `pnpm check` / `yarn check`, or equivalent) — and if it fails, report exactly what failed to the user. Do not auto-fix.
