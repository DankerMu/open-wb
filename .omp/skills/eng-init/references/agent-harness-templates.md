# Agent Harness Templates

Runtime harness + agent-native enforcement templates. Read this file in Stage 4 alongside `aux-file-templates.md`, once Dimension 7 (Runtime Verification, Q7.1–Q7.6) answers and the strictness profile are known.

Every template uses `{{PLACEHOLDER}}` substitution. eng-init placeholders are always `{{UPPER_SNAKE}}`. Lowercase `{{...}}` tokens (`{{route}}` in justfile recipes, `{{base_url}}` in `.hurl` files) are **runtime variables of the target tool** — leave them literal; do not substitute. Substitute every UPPER_SNAKE placeholder fully before writing; never leave one in a produced file.

Profile gating (canonical table: question-bank Q1.4):

- Runtime command block + guardrail self-test: write set at **L2+** (optional L1), rendered for the selected entry point (`justfile`, `Makefile`, or package scripts).
- API smoke tests: **recommended L2, required L3+** when an HTTP API exists. Maps to readiness `smoke_tests_exist`.
- UI verification (Playwright and/or agent-browser walk): **required L3+** when a UI exists.
- Evidence protocol (fresh command output, screenshots, PR `## Runtime evidence`): **all profiles**.
- Violation baseline + ratchet: bootstrap/incremental when Stage 0 found violations and Q1.4b = `freeze-baseline`.
- `.claude/settings.json`: conditional — only when Claude Code is among the AI tools (Q1.5).

`{{HEALTH_URL}}`, `{{DEV_PORT}}`, `{{KEY_API_ROUTES}}`, `{{KEY_UI_PATHS}}` resolve from `constraints.yaml` top-level `verification` key (populated from Q7.1–Q7.3; see `constraints-yaml-template.md`). Do not hardcode duplicates.

## File index

| File | Section below | Written when |
|------|---------------|--------------|
| Runtime command block (selected entry point: `justfile`, `Makefile`, or package scripts) | § Runtime command block | L2+ and Pillar 2 selected; Verification Matrix in AGENTS.md |
| `smoke/health.hurl`, `smoke/api.hurl` | § API smoke — Hurl templates | API exists; recommended L2, required L3+; Q7.5 API tool = hurl |
| `scripts/smoke.sh` (curl fallback) | § API smoke — Hurl templates | Repo refuses the hurl dependency (Q7.5 = curl scripts) |
| `playwright.config.ts`, `e2e/smoke.spec.ts` | § UI smoke — Playwright baseline | UI exists, L3+ (or opted in earlier); Q7.5 UI tool includes Playwright |
| agent-browser walk protocol (rendered into AGENTS.md Verification Matrix notes) | § agent-browser route walk | UI exists and Q7.5 UI tool includes agent-browser (or Playwright refused) |
| `scripts/test-guardrails.sh` | § Guardrail self-test | Always at L2+ (write set); wired as `{{TEST_GUARDRAILS_CMD}}` |
| `.claude/settings.json`, `.claude/hooks/pre-write-naming.sh` | § Agent-native enforcement | Claude Code among AI tools (Q1.5) |
| `constraints.yaml` `baseline` key + per-stack baseline configs | § Violation baseline & ratchet | Bootstrap/incremental, Q1.4b = freeze-baseline |
| `.github/workflows/agents-md-liveness.yml` | § AGENTS.md liveness check | CI selected (Pillar 5); addresses readiness `agents_md_validation` |
| Lockfile–manifest CI job (standalone job in `ci.yml`) | § Lockfile–manifest consistency | CI selected and lockfile committed (Q2.2) |
| `.tool-versions`, `.devcontainer/devcontainer.json` | § Toolchain pinning | Always recommended; devcontainer addresses readiness `devcontainer` |
| `.github/CODEOWNERS` | § CODEOWNERS critical paths | Q7.6 critical paths enumerated and team size ≥ small team (Q3.4) |
| Logger-lint rules + OTel init snippets | § Observability snippets | Dimension 8 artifacts; all profiles when observability wiring is in scope |
| Secret preflight step (first step of secret-consuming jobs) | § Secret preflight | Any workflow consumes a secret (real-API e2e, deploy, release) |
| Generator `--check` gate for generated docs | § Generated docs — derivation gate | Any committed doc is a projection of code (catalogs, graphs, notices); readiness `generated_docs_check_mode` |
| `scripts/change-scope.sh` (+ dev-entry `change-scope` target) | § Change scope — deterministic diff report | Always when AGENTS.md renders `### Scoped verification` (which is every profile) — it owns `{{CHANGE_SCOPE_CMD}}`, so skipping it leaves the placeholder unresolvable |
| Gate runner script + `.lint-fingerprint` | § Gate runner in code | Optional at L3+/monorepo when CI outgrows a handful of jobs |

---

## § Runtime command block

<!-- eng-init template version: 2026-06-10 -->

Render these commands through the selected dev entry point from Q5.1. For `just`, append the Justfile recipes below. For `make`, translate each recipe name to a Makefile target with the same observable behavior. For package-script repos, add matching `package.json` scripts (for example `dev:bg`, `dev:stop`, `dev:status`, `smoke`, `verify-ui`, `db:reset`, `test:guardrails`) and resolve the AGENTS.md command placeholders to those scripts. The command names may differ by entry point, but the placeholders (`{{DEV_BG_CMD}}`, `{{DEV_STATUS_CMD}}`, `{{SMOKE_CMD}}`, etc.) must resolve to real targets/scripts.

`.run/` holds pidfiles, dev logs, and UI evidence. It must be in `.gitignore` (generated artifacts are never committed).

```just
# === Runtime harness (L2+) ===
# Agents iterate against a *running* app, not a compile check.
# dev-bg/dev-stop/dev-status/logs document the dev-server lifecycle
# (readiness: dev_server_lifecycle_documented).

# Start the dev server detached in its own process group; poll the health
# endpoint until ready. The server runs in its own pgid (set -m in the shebang
# block enables job control so the background job gets a fresh pgid) so that
# dev-stop can kill the whole group, including forked workers.
dev-bg:
    #!/usr/bin/env bash
    # set -m enables job control → background job gets its own process group.
    set -euo pipefail -m
    mkdir -p .run
    if [ -f .run/dev.pid ] && kill -0 "$(cat .run/dev.pid)" 2>/dev/null; then
        echo "dev server already running (pid $(cat .run/dev.pid))"
        exit 0
    fi
    {{DEV_CMD}} > .run/dev.log 2>&1 &
    echo $! > .run/dev.pid
    {{IF_HEALTH_ENDPOINT}}
    for i in $(seq 1 {{HEALTH_TIMEOUT_SECONDS}}); do
        if curl -fsS "{{HEALTH_URL}}" > /dev/null 2>&1; then
            echo "dev server ready (pid $(cat .run/dev.pid)) — {{HEALTH_URL}}"
            exit 0
        fi
        sleep 1
    done
    echo "dev server not ready after {{HEALTH_TIMEOUT_SECONDS}}s — last log lines:" >&2
    tail -n 20 .run/dev.log >&2 || true
    kill "$(cat .run/dev.pid)" 2>/dev/null || true
    rm -f .run/dev.pid
    exit 1
    {{ELSE}}
    sleep {{PROCESS_STARTUP_GRACE_SECONDS}}
    if kill -0 "$(cat .run/dev.pid)" 2>/dev/null; then
        echo "dev process running (pid $(cat .run/dev.pid)); no health endpoint configured"
        exit 0
    fi
    echo "dev process exited before readiness; last log lines:" >&2
    tail -n 20 .run/dev.log >&2 || true
    rm -f .run/dev.pid
    exit 1
    {{END_IF}}

# Stop the dev server and its forked workers. Dev servers often fork worker
# processes; killing only the parent leaves orphans. We kill the whole process
# group via pgid so all children are reaped portably (macOS + Linux, no setsid).
dev-stop:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .run/dev.pid ]; then
        pid="$(cat .run/dev.pid)"
        # Derive pgid; tr strips leading whitespace that ps emits on some platforms.
        pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" || pgid=""
        if [ -n "$pgid" ] && [ "$pgid" != "0" ]; then
            kill -- "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
        else
            kill "$pid" 2>/dev/null || true
        fi
        rm -f .run/dev.pid
        echo "dev server stopped"
    else
        echo "no pidfile — dev server not running (or started outside dev-bg)"
    fi

# Show pid + health probe when available.
dev-status:
    #!/usr/bin/env bash
    if [ -f .run/dev.pid ] && kill -0 "$(cat .run/dev.pid)" 2>/dev/null; then
        echo "pid:    $(cat .run/dev.pid) (running)"
    else
        echo "pid:    not running"
    fi
    {{IF_HEALTH_ENDPOINT}}
    if curl -fsS "{{HEALTH_URL}}" > /dev/null 2>&1; then
        echo "health: OK ({{HEALTH_URL}})"
    else
        echo "health: UNREACHABLE ({{HEALTH_URL}})"
    fi
    {{ELSE}}
    echo "health: not configured; using process liveness only"
    {{END_IF}}

# Tail the dev-server log.
logs:
    tail -n 100 -f .run/dev.log

# API smoke against the running dev server (see § API smoke).
smoke:
    hurl --test smoke/*.hurl --variable base_url=http://localhost:{{DEV_PORT}}

# Full end-to-end suite.
e2e:
    {{E2E_CMD}}

# Verify one UI route. `route` (lowercase) is a just parameter, not an
# eng-init placeholder — leave it literal when writing this file.
verify-ui route:
    {{PLAYWRIGHT_RUN_CMD}} --grep "{{route}}"

# Reset the local database to a clean schema, then load seed data.
db-reset:
    {{DB_RESET_CMD}}

# Load deterministic seed data (readiness: seed_data_available).
seed:
    {{SEED_CMD}}

# Migration round-trip verification: reset a disposable local DB, apply all
# migrations up, roll the latest back, re-apply up, seed, and assert exit 0
# at each step. Satisfies the Verification Matrix migration row (`{{DB_VERIFY_CMD}}`).
db-verify: db-reset
    #!/usr/bin/env bash
    set -euo pipefail
    echo "--- apply up ---"
    {{MIGRATE_UP_CMD}}
    echo "--- roll back latest ---"
    {{MIGRATE_DOWN_CMD}}
    echo "--- re-apply up ---"
    {{MIGRATE_UP_CMD}}
    echo "--- seed ---"
    {{SEED_TARGET_CMD}}
    echo "db-verify passed"

# Prove every guard actually rejects violations (see § Guardrail self-test).
test-guardrails:
    bash scripts/test-guardrails.sh
```

Agent-browser-only UI verification (when Q7.5 UI tool = agent-browser only) is a protocol, not a passing shell verifier. Do **not** render a green `verify-ui` recipe that only prints instructions. Either select Playwright for an automated selected-entry command, or mark the UI row as `review-only / agent-browser protocol` with required screenshot + console evidence and no successful command target.

### Per-stack `{{CHECK_FAST_CMD}}` substitutions

The `check-fast` recipe itself lives in the base justfile template (`aux-file-templates.md` § Dev entry — justfile); this table only supplies `{{CHECK_FAST_CMD}}` values.

`check-fast` is lint-staged-style: derive changed files from `git diff`, run scoped checks only. Project-wide checks (full typecheck, integration tests, anti-drift) stay in `just check`.

| Stack | CHECK_FAST_CMD |
|-------|----------------|
| Node/TS | `changed=$(git diff --name-only --diff-filter=ACMR HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx'); if [ -z "$changed" ]; then echo "no changed source files"; exit 0; fi; pnpm eslint --max-warnings 0 $changed && pnpm prettier --check $changed && pnpm vitest related --run $changed` (full `tsc --noEmit` stays in `just check` — it cannot be file-scoped soundly) |
| Python (uv) | `changed=$(git diff --name-only --diff-filter=ACMR HEAD -- '*.py'); if [ -z "$changed" ]; then echo "no changed source files"; exit 0; fi; uv run ruff check $changed && uv run ruff format --check $changed; tests=$(echo "$changed" \| grep -E '(test_[^/]+\.py\|[^/]+_test\.py)$' \|\| true); if [ -z "$tests" ]; then echo "no changed test files — full suite via just check"; else uv run pytest -x -q $tests; fi` |
| Python (poetry) | Same as uv row, with `poetry run` instead of `uv run` |
| Go | `changed=$(git diff --name-only --diff-filter=ACMR HEAD -- '*.go'); if [ -z "$changed" ]; then echo "no changed Go files"; exit 0; fi; pkgs=$(echo "$changed" \| xargs -n1 dirname \| sort -u \| sed 's\|^\|./\|'); gofumpt -l $changed && golangci-lint run $pkgs && go test $pkgs` (empty-check before xargs — no GNU-only `-r` flag; bash 3.2 / macOS compatible) |
| Rust | `cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo nextest run` (cargo is incremental by design — scoping is automatic; do not hand-scope) |
| Java (gradle) | `./gradlew spotlessCheck test -x integrationTest` (Gradle incremental build scopes work automatically) |

### Per-stack `{{E2E_CMD}}` substitutions

`e2e` runs the full end-to-end suite. Required at L3+ when a UI or HTTP API surface exists (Q1.4 table, E2E row). If neither surface exists, omit the `e2e` target entirely — do not render a stub with a placeholder command.

| Stack | E2E_CMD |
|-------|---------|
| TypeScript (Playwright) | `pnpm playwright test` |
| Python (pytest-playwright or direct) | `pytest -m e2e` — or `playwright test` if using the Node Playwright runner from a Python repo |
| Go | `go test -tags e2e ./...` |
| Rust | `cargo test --test e2e` |
| Java (Maven) | `mvn -Pe2e verify` |
| Java (Gradle) | `./gradlew e2eTest` |
| No UI/API surface | omit target — do not render the `e2e` row in the Verification Matrix and do not write the target |

Also substitute `{{PLAYWRIGHT_RUN_CMD}}` = `pnpm playwright test` for TypeScript; `python -m pytest` (with `-m e2e`) for Python; omit `verify-ui` entirely for non-Playwright stacks (use the agent-browser variant or drop the target).

### Per-stack `{{DB_RESET_CMD}}` / `{{SEED_CMD}}` examples

| Stack / ORM | DB_RESET_CMD | SEED_CMD |
|-------------|--------------|----------|
| Prisma | `pnpm prisma migrate reset --force --skip-seed` | `pnpm prisma db seed` |
| SQLAlchemy + Alembic | `uv run alembic downgrade base && uv run alembic upgrade head` | `uv run python -m {{APP}}.seed` |
| Go + goose | `goose -dir migrations postgres "$DATABASE_URL" reset && goose -dir migrations postgres "$DATABASE_URL" up` | `go run ./cmd/seed` |
| Rust + sqlx | `sqlx database reset -y` | `cargo run --bin seed` |
| Java + Flyway | `./gradlew flywayClean flywayMigrate` | `./gradlew loadSeedData` |

### Per-stack `{{MIGRATE_UP_CMD}}` / `{{MIGRATE_DOWN_CMD}}` substitutions for `db-verify`

| Stack / ORM | MIGRATE_UP_CMD | MIGRATE_DOWN_CMD |
|-------------|----------------|------------------|
| Prisma | `pnpm prisma migrate deploy` | `pnpm prisma migrate resolve --rolled-back $(pnpm prisma migrate status --json \| jq -r '.appliedMigrations[-1].migrationName')` — or use `pnpm prisma migrate reset --force --skip-seed` as the down step when single-step rollback is impractical |
| SQLAlchemy + Alembic | `uv run alembic upgrade head` | `uv run alembic downgrade -1` |
| Go + goose | `goose -dir migrations postgres "$DATABASE_URL" up` | `goose -dir migrations postgres "$DATABASE_URL" down` |
| Rust + sqlx | `sqlx migrate run` | `sqlx migrate revert` |
| Java + Flyway | `./gradlew flywayMigrate` | `./gradlew flywayUndo` (requires Flyway Teams) or a custom `./gradlew flywayRepairAndRevert` target |

### Background-job surface note

`{{JOB_VERIFY_CMD}}` has no generic template — the invocation is entirely repo-specific. Repos must either:

- Define a concrete target (e.g. `just run-job NAME`), substituting the real command, and include it in the Verification Matrix; or
- Drop the background-job row from the Verification Matrix entirely.

**Never render the background-job row without a concrete, runnable target.** A placeholder `{{JOB_VERIFY_CMD}}` left in AGENTS.md or constraints.yaml is phantom verification — agents will attempt to run it verbatim and fail silently or produce misleading green output.

Render the dev-server lifecycle (`dev-bg` → `dev-status` → `logs` → `dev-stop`) and these targets into the AGENTS.md `## Development Workflow` command table and `## Verification Matrix` (required at L2+, optional L1; readiness: `verification_matrix`).

---

## § API smoke — Hurl templates

<!-- eng-init template version: 2026-06-10 -->

Smoke tests prove the app actually serves requests — the cheapest runtime evidence an agent can produce. One assertion of status + one jsonpath per route; this is smoke, not integration. In `.hurl` files, lowercase `{{base_url}}` is a **hurl runtime variable** injected via `--variable` — leave it literal.

Path: `smoke/health.hurl` (Q7.1 supplies `{{HEALTH_PATH}}`):

```hurl
# smoke/health.hurl — liveness probe.
GET {{base_url}}{{HEALTH_PATH}}

HTTP 200
[Asserts]
jsonpath "$.status" == "ok"
```

Path: `smoke/api.hurl` — skeleton; render one entry per route in `{{KEY_API_ROUTES}}` (Q7.2):

```hurl
# smoke/api.hurl — key API routes (Q7.2). Keep in sync with the
# AGENTS.md ## Verification Matrix and constraints.yaml `verification`.

GET {{base_url}}{{API_ROUTE_1}}

HTTP 200
[Asserts]
jsonpath "$.{{ROUTE_1_FIELD}}" exists

POST {{base_url}}{{API_ROUTE_2}}
Content-Type: application/json
{
  {{ROUTE_2_BODY_JSON}}
}

HTTP 201
[Asserts]
jsonpath "$.id" exists
```

Run locally (after `{{DEV_BG_CMD}}`):

```bash
{{SMOKE_CMD}}
# expands to: hurl --test smoke/*.hurl --variable base_url=http://localhost:{{DEV_PORT}}
```

CI: append to `layer3-integration-tests` in `.github/workflows/ci.yml` (aux-file-templates § CI workflow):

```yaml
      {{ENTRYPOINT_SETUP_STEPS}}
      - name: Install hurl
        run: |
          curl -fsSL --retry 3 -o /tmp/hurl.deb \
            https://github.com/Orange-OpenSource/hurl/releases/download/{{HURL_VERSION}}/hurl_{{HURL_VERSION}}_amd64.deb
          sudo dpkg -i /tmp/hurl.deb
      - name: API smoke
        run: |
          {{DEV_BG_CMD}}
          {{SMOKE_CMD}}
          {{DEV_STOP_CMD}}
```

### Pure-curl fallback

When the repo refuses the hurl dependency (Q7.5 = curl scripts), write `scripts/smoke.sh` and point `{{SMOKE_CMD}}` at it instead. The grep-based field check is deliberately weaker than jsonpath — say so in AGENTS.md; this is why hurl is the recommended option.

Path: `scripts/smoke.sh` (chmod +x after writing):

```bash
#!/usr/bin/env bash
# scripts/smoke.sh — pure-curl API smoke. bash 3.2 compatible, no deps beyond curl.
set -u

BASE_URL="${BASE_URL:-http://localhost:{{DEV_PORT}}}"
body_file="$(mktemp "${TMPDIR:-/tmp}/smoke-body.XXXXXX")"
trap 'rm -f "$body_file"' EXIT
fail=0

# probe METHOD PATH EXPECTED_STATUS [REQUIRED_JSON_FIELD]
probe() {
  method="$1"; path="$2"; expected="$3"; field="${4:-}"
  status="$(curl -sS -X "$method" -o "$body_file" -w '%{http_code}' "$BASE_URL$path" 2>/dev/null)" || status="000"
  if [ "$status" != "$expected" ]; then
    echo "FAIL  $method $path — expected $expected, got $status"
    fail=1
    return
  fi
  if [ -n "$field" ] && ! grep -q "\"$field\"" "$body_file"; then
    echo "FAIL  $method $path — body missing field \"$field\""
    fail=1
    return
  fi
  echo "PASS  $method $path ($status)"
}

probe GET "{{HEALTH_PATH}}" 200 status
# {{KEY_API_ROUTES}} — one probe line per route from Q7.2:
probe GET "{{API_ROUTE_1}}" 200 "{{ROUTE_1_FIELD}}"

exit "$fail"
```

Either variant satisfies readiness `smoke_tests_exist`. Recommended at L2; required at L3+ when an HTTP API exists — skipping it at L3+ is a downgrade requiring explicit confirmation and a ledger entry.

---

## § UI smoke — Playwright baseline

<!-- eng-init template version: 2026-06-10 -->

Minimal baseline: walk every path in `{{KEY_UI_PATHS}}` (Q7.3), fail on any console error, screenshot each route into `.run/ui-evidence/`. Test titles embed the route path so `{{VERIFY_UI_CMD}}` can target a single route (for example with a Playwright grep/filter argument). Required at L3+ when a UI exists (Q1.4 table, E2E row).

Path: `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:{{DEV_PORT}}',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: '{{DEV_CMD}}',
    url: '{{HEALTH_URL}}',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
```

Path: `e2e/smoke.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';

// {{KEY_UI_PATHS}} from Q7.3 — keep in sync with AGENTS.md ## Verification Matrix.
const routes: { path: string; name: string }[] = [
  { path: '/', name: 'home' },
  { path: '{{UI_PATH_2}}', name: '{{UI_PATH_2_NAME}}' },
];

fs.mkdirSync('.run/ui-evidence', { recursive: true });

for (const route of routes) {
  test(`route ${route.path} renders without console errors`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    const response = await page.goto(route.path);
    expect(response?.ok(), `HTTP status for ${route.path}`).toBe(true);
    // 'load' fires reliably on all apps. 'networkidle' never resolves on apps
    // with polling, SSE, or WebSocket connections — use 'load' + a ready selector.
    await page.waitForLoadState('load');
    await page.waitForSelector('{{READY_SELECTOR}}'); // e.g. '[data-testid="app-ready"]' or 'main'

    await page.screenshot({
      path: `.run/ui-evidence/${route.name}.png`,
      fullPage: true,
    });

    expect(consoleErrors, `console errors on ${route.path}`).toEqual([]);
  });
}
```

Wire `{{E2E_CMD}}` = `pnpm playwright test` and `{{PLAYWRIGHT_RUN_CMD}}` = `pnpm playwright test`. Screenshots in `.run/ui-evidence/` are the evidence the PR `## Runtime evidence` section references — never committed (`.run/` is gitignored).

Note on `verify-ui route`: the `route` argument is passed to Playwright via `--grep` and is treated as a **regex**, not a literal string. Metacharacters in route paths (e.g. `/`, `.`, `?`) must be escaped or the grep may match unintended tests. Prefer matching by exact test title (e.g. `verify-ui "route / renders"`) or escape path separators (`verify-ui "route \\/path"`).

---

## § agent-browser route walk (no-Playwright fallback)

When Q7.5 chose agent-browser (alone or alongside Playwright), the interactive walk below is the UI verification method. It is a **protocol, not a file** — render the reference into the AGENTS.md `## Verification Matrix` notes so every agent session follows the same steps. Evidence protocol applies at all profiles: UI claims require a screenshot plus zero new console errors.

For **each route** in the Verification Matrix:

1. `{{DEV_BG_CMD}}`, then `{{DEV_STATUS_CMD}}` — proceed only when health is OK.
2. Load the route in the browser. Read the console; record any pre-existing errors as the baseline for this route (an empty baseline is the expected case — a non-empty one is debt for `## Important Development Notes`).
3. Take a screenshot; save under `.run/ui-evidence/<route-name>.png`.
4. Exercise the **primary action** listed in the Verification Matrix row for this route (submit the form, click the CTA, complete the flow) and confirm the expected result renders.
5. Re-read the console. Assert **zero new errors** versus the step-2 baseline. Any new error fails the walk — fix or report; do not narrate around it.
6. Append one evidence row per route to the PR `## Runtime evidence` section:

```markdown
| Route | Primary action | Result | Screenshot | New console errors |
|-------|----------------|--------|------------|--------------------|
| {{ROUTE}} | {{ACTION}} | pass | .run/ui-evidence/{{ROUTE_NAME}}.png | 0 |
```

7. `{{DEV_STOP_CMD}}` when the walk is complete.

Rules: success claims require fresh output from the current session — a walk performed in an earlier session is not evidence. If a route cannot be verified (missing seed data, broken upstream), say so explicitly in the evidence section; do not mark it pass. `"None — review-only change"` is an acceptable Runtime evidence entry only with the reason stated.

---

## § Gate runner in code (optional — L3+/monorepo)

<!-- eng-init template version: 2026-08-02 -->

When CI outgrows a handful of jobs, keep the gate inventory in **one tested script** and let workflow YAML only provision runners — duplicating the check list into YAML is how the scheduler and reality drift apart.

Shape (any language; keep it boring):

- One gate = `{id, command, needs[]}`; the dependency graph is validated **before** any gate starts (reject duplicate ids, unknown deps, cycles).
- A gate whose dependency failed reports `skipped: dependency <id> failed` explicitly — never silently absent.
- Report orthogonal outcomes independently: error, exit code, and signal are three separate facts; nesting one report inside another's branch hides it.
- Buffer each gate's output and print it attributed on completion so parallel logs stay readable.
- The runner is code: it gets a test (graph validation, failure propagation, lane membership).

Rule-set fingerprint — the cheapest meta-gate on top:

```bash
# scripts/lint-fingerprint.sh — fail when the effective rule set changes silently.
# Changing rules becomes a reviewable act: update .lint-fingerprint in the same
# PR with a justification, or the build is red.
set -euo pipefail
{{LINT_PRINT_CONFIG_CMD}} | shasum -a 256 | cut -d' ' -f1 > "${TMPDIR:-/tmp}/lint.fp"
if ! diff -q "${TMPDIR:-/tmp}/lint.fp" .lint-fingerprint >/dev/null; then
  echo "::error::Effective lint rule set changed. Update .lint-fingerprint in this PR and justify the rule change."
  exit 1
fi
```

## § Change scope — deterministic diff report

<!-- eng-init template version: 2026-08-02 -->

Input for AGENTS.md `### Scoped verification`: an explicit, deterministic inventory of what changed. The script never guesses a base, never fetches, and never selects tests itself — selection stays a judgment made on top of honest data.

```bash
#!/usr/bin/env bash
# scripts/change-scope.sh <base-ref> — deterministic change inventory.
# Explicit base required: guessing origin/<branch> fails on unpushed worktrees
# and misreports stacked branches. Rename detection is off so both sides of a
# rename stay visible to check selection.
set -euo pipefail
BASE="${1:?usage: change-scope.sh <base-ref> (explicit; this script never guesses a base)}"
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || {
  echo "error: base '$BASE' does not resolve locally; fetch it yourself first" >&2; exit 2; }
MERGE_BASE=$(git merge-base "$BASE" HEAD)
echo "# base=$BASE merge_base=$MERGE_BASE head=$(git rev-parse HEAD)"
echo "## committed"; git -c diff.renames=false diff --name-status "$MERGE_BASE"..HEAD
echo "## staged";    git -c diff.renames=false diff --name-status --cached
echo "## unstaged";  git -c diff.renames=false diff --name-status
echo "## untracked"; git ls-files --others --exclude-standard
```

Wire it as a dev-entry target (`just change-scope base=origin/main` or equivalent) and substitute `{{CHANGE_SCOPE_CMD}}` in AGENTS.md with that target. Re-run after any retarget or base merge — a scope report is stale the moment the base moves.

## § Generated docs — derivation gate

<!-- eng-init template version: 2026-08-02 -->

For any committed doc that is a projection of code (API/CLI/config catalogs, dependency graphs, license notices): generate it, never hand-edit it, and gate freshness as an **equality assertion**. mtime-based freshness (`documentation_freshness`) is the weak form — a touch proves nothing; derivation equality is the strong form (`generated_docs_check_mode`).

Every generator ships two modes:

```
scripts/gen-<doc> --write   # regenerate the committed output
scripts/gen-<doc> --check   # exit non-zero when committed output != freshly regenerated output
```

CI runs every `--check`; a drifted doc is a red build, not a review comment.

Rules:

- Mark generated outputs (header comment + an AGENTS.md "never hand-edit; edit the generator or its source annotations" note). Hand-edits are overwritten by design.
- Give each generator a coverage-completeness check: its input inventory must account for everything on disk (e.g., every `tools/*` module appears in the tool catalog), so a new item cannot silently stay out of the projection.
- **The generator is deterministic and idempotent** — byte-equality checking depends on it. Stable sort order for every collection, no timestamps, no absolute paths, no random ids; separate pure collect/render steps from I/O so the `--check` mode can render in memory. A non-deterministic generator cannot be gated and its output is effectively uncontrolled.
- The generator is code: it gets a test. Its quality ceiling is the source annotations it projects — enforce doc comments at the source (JSDoc/docstrings, lint-gated) before trusting the projection.

## § Secret preflight

<!-- eng-init template version: 2026-08-02 -->

Any workflow that consumes a secret (real-API e2e, deploy, publish) starts with an unconditional presence check. Without it, a missing or misconfigured secret turns the whole suite into self-skips — an invisible false pass that reads green exactly when the safety net is off.

First step of every secret-consuming job:

```yaml
      - name: Preflight — required secret present
        env:
          REQUIRED_SECRET: ${{ secrets.{{SECRET_NAME}} }}
        run: |
          if [ -z "$REQUIRED_SECRET" ]; then
            echo "::error::Secret {{SECRET_NAME}} is empty or not configured for this repository/event. Configure it in Settings -> Secrets, or remove this workflow."
            exit 1
          fi
```

Rules:

- Gate the job to trusted events (push to the main repo, manual dispatch, same-repo PRs) at job level — `if: github.actor != 'dependabot[bot]' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)` — because fork PRs and Dependabot never receive secrets; the preflight must then fail only when the secret is genuinely missing, never as fork noise. (The `github.event_name != 'pull_request'` disjunct is load-bearing: `github.event.pull_request` is absent on push/dispatch events, so a bare equality check is falsy there and would skip the job on exactly the trusted events it should run on.)
- Per-capability self-skips in tests (`skipIf(!process.env.KEY)`) are an availability mechanism for keyless contributors, not a cost signal. Keep them — but the CI preflight above must hard-fail so "secret missing" is a visible failure instead of a silent all-skip green.
- A job that exists to prove a capability asserts "N passed, 0 skipped" (or the runner's equivalent) so a fully-skipped suite cannot report success.
- Keep secret-gated jobs out of the CI aggregator's `needs`: their trusted-event `if:` legitimately skips on fork PRs, which the aggregator would read as failure. Their evidence is required on trusted pushes, not on fork PRs.

## § Guardrail self-test

<!-- eng-init template version: 2026-08-08 -->

A guard that silently accepts violations — typo'd regex, non-executable hook, missing config — is **phantom enforcement**, worse than no guard because it creates false confidence. This script is the proof against it, and it asserts **both directions** of the dual assertion (`gate-quality-contract.md`): first that each guard accepts the clean worktree (a rejection-only self-test is blind to always-failing guards), then that each guard exits non-zero on one deliberately staged violation.

In the write set at L2+ (readiness: `guardrail_self_test`). Wire as `{{TEST_GUARDRAILS_CMD}}`. Run it in Stage 5 after writes (alongside `{{CHECK_CMD}}`), and as a low-frequency CI job — guards change rarely, so weekly is enough:

```yaml
# Job snippet — add to .github/workflows/agents-md-liveness.yml (same weekly cron).
  guardrail-self-test:
    name: Guardrail self-test
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: bash scripts/test-guardrails.sh
```

Path: `scripts/test-guardrails.sh` (chmod +x after writing). bash 3.2 compatible (macOS default): no `mapfile`, no associative arrays, no extra deps beyond git and the guards themselves. Requires at least one commit (`git worktree` needs HEAD) — in a brand-new repo, run it after the initial commit.

```bash
#!/usr/bin/env bash
# scripts/test-guardrails.sh — proves each wired guard actually rejects what it
# claims to reject. Creates one violation per guard in a throwaway worktree and
# asserts the guard EXITS NON-ZERO. Exit 126/127 (missing tool, non-executable
# hook) counts as FAIL — "not runnable" is phantom enforcement, not rejection.
set -u

repo_root="$(git rev-parse --show-toplevel)" || exit 1
tmp="$(mktemp -d "${TMPDIR:-/tmp}/guardrails.XXXXXX")"
wt="$tmp/wt"

cleanup() {
  cd "$repo_root" || exit 1
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

git -C "$repo_root" worktree add --quiet --detach "$wt" || {
  echo "FATAL: could not create temp worktree (need at least one commit)" >&2
  exit 1
}
cd "$wt" || exit 1

pass=0
fail=0

# expect_reject NAME REASON CMD... — guard must exit non-zero on the staged
# violation AND say why. REASON is a substring the guard's own message must
# contain, per the self-proof contract: "assert non-zero exit **and** that the
# error message contains the location and reason. Assert message substrings,
# not exact output or line numbers."
#
# A non-zero exit alone is not a rejection. A guard that crashes — traceback,
# `set -u` on an unset variable, a syntax error introduced by an edit — exits
# non-zero too, and an exit-code-only assertion reports that broken guard as
# PASS. That is phantom enforcement wearing a green badge: the self-test says
# the guard works precisely when it has stopped working.
expect_reject() {
  name="$1"
  reason="$2"
  shift 2
  out=$("$@" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL  $name — guard ACCEPTED the violation (phantom enforcement)"
    fail=$((fail + 1))
  elif [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    echo "FAIL  $name — guard not runnable (exit $rc): missing tool or non-executable hook"
    fail=$((fail + 1))
  elif ! printf '%s\n' "$out" | grep -qF -- "$reason"; then
    echo "FAIL  $name — exited $rc without naming \"$reason\" — crash, not rejection:"
    printf '%s\n' "$out" | sed 's/^/        /'
    fail=$((fail + 1))
  else
    echo "PASS  $name — guard rejected the violation and named it (exit $rc)"
    pass=$((pass + 1))
  fi
}

skip() {
  echo "SKIP  $1 — $2 (a skipped guard is a readiness gap, not a pass)"
}

# expect_accept NAME CMD... — guard must exit zero on the clean tree. Without
# this, an always-failing guard (crashed setup, typo'd path, wrong invocation)
# passes a rejection-only self-test: every later "rejection" proves nothing.
expect_accept() {
  name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS  $name — guard accepts the clean tree"
    pass=$((pass + 1))
  else
    echo "FAIL  $name — guard REJECTED the clean tree (always-failing guard or broken setup)"
    fail=$((fail + 1))
  fi
}

# 0. Clean-state baseline — every directly runnable guard must accept the
#    untouched worktree before any violation is staged.
expect_accept "naming guard (clean tree)" bash .git-hooks/check-naming.sh

# 1. Naming guard — forbidden suffix.
echo "guardrail self-test" > "foo_v2.{{EXT}}"
git add "foo_v2.{{EXT}}"
expect_reject "naming guard (foo_v2.{{EXT}})" "forbidden naming suffix" \
  bash .git-hooks/check-naming.sh
git reset --quiet -- "foo_v2.{{EXT}}"
rm -f "foo_v2.{{EXT}}"

# 2. Scratchpad guard — forbidden directory.
mkdir -p scratch
echo "guardrail self-test" > scratch/note.txt
git add scratch/note.txt
expect_reject "scratchpad guard (scratch/)" "scratchpad directory" \
  bash .git-hooks/check-naming.sh
git reset --quiet -- scratch/note.txt
rm -rf scratch

# 3. Large-file guard — 600 KB generated file (ceiling: 500 KB, see
#    .pre-commit-config.yaml check-added-large-files --maxkb=500).
dd if=/dev/zero of=generated.bin bs=1024 count=600 2>/dev/null
git add generated.bin
if [ -f .pre-commit-config.yaml ] && command -v pre-commit >/dev/null 2>&1; then
  expect_reject "large-file guard (600 KB generated.bin)" "exceeds" \
    pre-commit run check-added-large-files --files generated.bin
else
  skip "large-file guard" "no runnable large-file hook found"
fi
git reset --quiet -- generated.bin
rm -f generated.bin

# 4. Commit-message guard — non-conventional message.
#    Unlike the naming guards above, the rejection text here comes from whichever
#    commit-message tool the repo chose, so it cannot be hard-coded in a template.
#    Resolve {{COMMIT_MSG_REJECT_SUBSTRING}} to a substring that tool actually
#    prints — run the guard against a bad message once and copy from its output:
#      .git-hooks/commit-msg (bash template) -> "Commit message must use Conventional Commits"
#      commitizen (cz check)                 -> "commit validation: failed!"
#      commitlint                            -> "may not be empty"
badmsg="$tmp/badmsg"
echo "bad message" > "$badmsg"
if [ -f .git-hooks/commit-msg ]; then
  expect_reject "commit-msg guard (\"bad message\")" "{{COMMIT_MSG_REJECT_SUBSTRING}}" \
    bash .git-hooks/commit-msg "$badmsg"
elif [ -f "$repo_root/commitlint.config.js" ]; then
  # commitlint needs node_modules — run from the real repo root, not the worktree.
  expect_reject "commit-msg guard (\"bad message\")" "{{COMMIT_MSG_REJECT_SUBSTRING}}" \
    sh -c "cd '$repo_root' && npx --no-install commitlint --edit '$badmsg'"
else
  skip "commit-msg guard" "no commit-msg hook found"
fi

echo
echo "guardrail self-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

Adjust `{{EXT}}` to the repo's primary source extension (`ts`, `py`, `go`, `rs`, `java`) so lint-time naming rules and the hook are both exercised. Resolve `{{COMMIT_MSG_REJECT_SUBSTRING}}` by running the repo's commit-message guard against a bad message once and copying a substring of what it prints — leaving it unresolved is caught by `check_rendered_harness.py`, which scans `test-guardrails.sh` for unresolved placeholders. SKIP lines are gaps: if the self-test reports SKIP for a guard the AGENTS.md Enforcement Index lists as `block`, that row is phantom enforcement — fix the wiring or downgrade the row honestly.

---

## § Agent-native enforcement (.claude/settings.json)

<!-- eng-init template version: 2026-06-10 -->

Conditional artifact — write only when Claude Code is among the repo's AI tools (Q1.5). **Write-time beats commit-time beats CI**: the same `_v2` violation costs one blocked tool call at write time, one failed commit at hook time, and a full CI round-trip plus review noise at CI time. This is the earliest, cheapest enforcement layer. It only covers Claude Code sessions, so the pre-commit hook and CI layers stay mandatory — this is an addition, never a replacement.

Path: `.claude/settings.json` (repo-shared, checked in; personal overrides go in `.claude/settings.local.json`, which is gitignored):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/pre-write-naming.sh"
          }
        ]
      }
    ]
  },
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(*--no-verify*)"
    ]
  }
}
```

Caveat — `.env.example`: Claude Code deny rules take precedence over allow rules, so `Read(./.env.*)` also blocks `.env.example`. Either accept the over-block (the file is tracked; its content is reachable via git anyway) or replace the wildcard with an enumerated list (`Read(./.env.local)`, `Read(./.env.development)`, `Read(./.env.production)`). State the chosen trade-off in AGENTS.md `### Secrets handling`.

Path: `.claude/hooks/pre-write-naming.sh` (chmod +x after writing). Receives the PreToolUse JSON payload on stdin; exit 2 blocks the tool call and feeds stderr back to the agent:

```bash
#!/usr/bin/env bash
# .claude/hooks/pre-write-naming.sh — write-time naming guard for Claude Code.
# Catches _v2 files at write time, before commit time. Delegates the actual
# check to .git-hooks/check-naming.sh so there is exactly one regex source.
set -u
payload="$(cat)"
if command -v jq >/dev/null 2>&1; then
  file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"
else
  # Dependency-free fallback: first "file_path":"..." value in the payload.
  file_path="$(printf '%s' "$payload" \
    | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi
[ -z "$file_path" ] && exit 0
exec bash .git-hooks/check-naming.sh "$file_path"
```

The base `check-naming.sh` template in `aux-file-templates.md` natively supports single-path-argument mode: when called as `bash .git-hooks/check-naming.sh <path>`, it validates that one path against the forbidden-suffix and scratchpad regexes (exit 2 on violation, exit 0 otherwise) instead of reading the staged index. The hook above (`exec bash .git-hooks/check-naming.sh "$file_path"`) relies on this mode directly — no patching required for repos generated from the current template.

**Repos generated by eng-init before 2026-06** (where `check-naming.sh` reads only the staged index): apply this patch — insert the block immediately after the regex resolution and before the `git diff --cached` loop:

```bash
# Path-argument mode (agent write-time check): if a path is supplied,
# validate it directly instead of reading the staged index.
if [ "$#" -gt 0 ]; then
  f="$1"
  if [[ "$f" =~ $FORBIDDEN_SUFFIX_RE ]] || [[ "$f" =~ $SCRATCH_DIR_RE ]]; then
    echo "naming violation (write-time): $f — see AGENTS.md § Code Canonicality" >&2
    exit 2
  fi
  exit 0
fi
```

Other-tool equivalents: `.cursorrules` must **point back to AGENTS.md, not duplicate it** — duplicated rules drift apart and the copy becomes the lie:

```
Read AGENTS.md at the repo root before any work. It is the single source of
truth for commands, boundaries, validation, and constraints. CONTEXT.md holds
the domain language. Do not add rules here; propose changes to AGENTS.md.
```

List `.claude/settings.json` hooks and denies in the AGENTS.md Enforcement Index at level `block` with scope noted ("Claude Code sessions only").

---

## § Violation baseline & ratchet

<!-- eng-init template version: 2026-06-10 -->

Applies in bootstrap/incremental mode when the Stage 0 scan found pre-existing violations against the chosen profile's gates, and grilling Q1.4b answered **freeze-baseline** (Recommended). The other Q1.4b options need no templates: `fix-now` fixes violations in the init change itself; `downgrade-profile` is a profile change recorded in the strictness ledger.

Freeze-baseline principle: existing violations are frozen as ceilings; **new code is held to the full profile standard; counts only go down**. Raising any ceiling requires the same explicit user confirmation + ledger entry as a profile downgrade. Tracked via the `constraints.yaml` top-level `baseline` key (readiness: `violation_baseline_tracked`):

AGENTS.md baseline section — the removal trigger is the FIRST sentence (rendering rule: temporary rules embed their own removal trigger):

```markdown
### Legacy violation baseline (temporary)

Remove this section — together with the `baseline` block in `constraints.yaml` and the baseline-comparison CI step — when every Baseline count below reaches 0. This freeze is valid only under its precondition: new and changed code is held to the full {{PROFILE_LEVEL}} gates and ceilings only decrease; it is a debt schedule with an end state of zero, not a permanent exemption.

| Gate | Baseline | Next milestone target | Owner |
|------|----------|----------------------|-------|
| {{GATE_1}} | {{BASELINE_COUNT_1}} | {{TARGET_1}} | {{OWNER_1}} |
```

```yaml
baseline:
  rev: "{{BASELINE_REV}}"          # commit SHA at freeze time
  frozen_on: "{{ISO_DATE}}"
  counts:                          # ceilings — CI fails on any increase
    duplicate_code: {{JSCPD_CLONE_COUNT}}    # CI-compared (ratchet step above)
    lint_errors: {{LINT_ERROR_COUNT}}         # CI-compared
    dead_code: {{DEAD_CODE_COUNT}}            # advisory only — not yet CI-compared
    size_violations: {{OVERSIZE_FILE_COUNT}}  # advisory only — not yet CI-compared
  ratchet_rule: "counts only go down; raising a ceiling = profile downgrade (confirm + ledger)"
```

### Per-stack baseline mechanisms

| Stack | Mechanism | Effect |
|-------|-----------|--------|
| Go | `.golangci.yml` → `issues:` `new-from-rev: {{BASELINE_REV}}` | Only issues introduced after the baseline rev fail; legacy issues reported, not blocking |
| TS (ESLint / jscpd) | No native baseline — record current counts in `constraints.yaml` `baseline.counts`; CI step compares and fails on increase (snippet below) | Totals may not rise; any PR that adds a violation must remove one elsewhere |
| Python (ruff) | `per-file-ignores` generated **once** at freeze time (`ruff check --add-noqa`, or a `[tool.ruff.lint.per-file-ignores]` block listing the violating files/rules) | Legacy files exempt per rule; new files fully gated. Never regenerate — regeneration is a silent ceiling raise |
| Rust | Counts ceiling in `baseline.counts` (clippy has no baseline mode); compare CI step as for TS | Totals may not rise |
| Java | Checkstyle/PMD suppression file generated once at freeze time, path-scoped | Legacy paths exempt; new code fully gated |

CI compare step (count-ceiling stacks) — append to `layer4-anti-drift`:

```yaml
      - name: Baseline ratchet — duplicate code
        run: |
          pnpm jscpd --reporters json --output .run/jscpd
          current=$(jq '.statistics.total.clones' .run/jscpd/jscpd-report.json)
          ceiling=$(yq '.baseline.counts.duplicate_code' constraints.yaml)
          if [ -z "$ceiling" ] || [ "$ceiling" = "null" ]; then
            echo "::error::baseline ceiling missing from constraints.yaml — run eng-init repair"
            exit 1
          fi
          if [ -z "$current" ] || [ "$current" = "null" ]; then
            echo "::error::could not read clone count from jscpd report"
            exit 1
          fi
          echo "clones: $current (ceiling: $ceiling)"
          if [ "$current" -gt "$ceiling" ]; then
            echo "::error::duplicate-code count rose above the frozen baseline ($current > $ceiling). Fix the new duplication; do not raise the ceiling."
            exit 1
          fi
```

Note: `dead_code` and `size_violations` ceilings are recorded in `constraints.yaml` but are advisory only — they are not yet compared in CI. Treat them as review-only signals until a parallel agent adds their ratchet steps.

When counts drop, lower the ceiling in the same PR — a ceiling above the actual count is slack that will silently refill.

### Ratchet table template

Render alongside the AGENTS.md Enforcement Index so the debt-paydown plan is visible where the gates are listed:

```markdown
| Gate | Baseline | Next milestone target | Owner |
|------|----------|-----------------------|-------|
| {{GATE_1}} | {{BASELINE_COUNT_1}} | {{TARGET_1}} | {{OWNER_1}} |
| {{GATE_2}} | {{BASELINE_COUNT_2}} | {{TARGET_2}} | {{OWNER_2}} |
```

---

## § AGENTS.md liveness check

<!-- eng-init template version: 2026-06-10 -->

AGENTS.md is project memory; stale memory is worse than none — agents trust and execute documented commands. This CI job validates that the AGENTS.md Development Workflow command table still matches reality. Addresses readiness criterion `agents_md_validation`.

Path: `.github/workflows/agents-md-liveness.yml`:

```yaml
name: AGENTS.md liveness

on:
  schedule:
    - cron: "0 6 * * 1"   # weekly, Monday 06:00 UTC
  pull_request:
    paths: [AGENTS.md, justfile, Makefile, package.json]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  liveness:
    name: AGENTS.md command table vs selected entry point
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      {{ENTRYPOINT_SETUP_STEPS}}
      - name: Diff documented commands against actual targets
        run: |
          {{COMMAND_TARGET_SUMMARY_CMD}} > /tmp/targets.txt
          {{DOCUMENTED_COMMANDS_EXTRACT_CMD}} > /tmp/documented.txt
          missing="$(comm -13 /tmp/targets.txt /tmp/documented.txt || true)"
          if [ -n "$missing" ]; then
            echo "::error::AGENTS.md documents commands that do not exist in the selected entry point:"
            echo "$missing"
            exit 1
          fi
          undocumented="$(comm -23 /tmp/targets.txt /tmp/documented.txt || true)"
          if [ -n "$undocumented" ]; then
            echo "::warning::entry-point targets/scripts not documented in AGENTS.md (add or intentionally omit):"
            echo "$undocumented"
          fi
      - name: Smoke-run documented commands (safe subset)
        run: |
          # Dry-run/safe-run the documented commands for the selected entry point.
          # The concrete implementation is entry-point specific:
          # - just: `just --dry-run <target>` for no-arg recipes.
          # - make: `make -n <target>` for no-arg targets.
          # - package scripts: validate `package.json` script existence and run safe `--help`/`--version` probes only.
          {{ENTRYPOINT_DRY_RUN_DOC_COMMANDS}}
          {{SAFE_SMOKE_CMDS}}
```

Notes:

- The extraction and dry-run snippets must match the selected entry point (`justfile`, `Makefile`, or package scripts). Do not hard-code `just` commands when Q5.1 selected `make` or package scripts.
- Never smoke-run deploy, db, or destructive targets here — dry-run only. The selected entry point's dry-run mode is the safety boundary.
- The § Guardrail self-test job rides this same workflow (same weekly cadence).

---

## § Lockfile–manifest consistency

<!-- eng-init template version: 2026-06-10 -->

A lockfile that changes without its manifest changing usually means someone (often an agent) ran a raw update command or installed with a different tool version — an unreviewed dependency-resolution change. Fail it with an explanation.

Add as a **standalone job** in `.github/workflows/ci.yml`. Do NOT append its steps to `layer1-fast-checks` — `layer1` uses a shallow checkout that lacks `$BASE_SHA`, so `git diff` fails or silently passes. This job needs its own `actions/checkout@v4` with `fetch-depth: 0`:

```yaml
  lockfile-consistency:
    name: Lockfile–manifest consistency
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Check lockfile–manifest pairs
        if: "!contains(github.event.pull_request.labels.*.name, 'lockfile-refresh')"
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: |
          changed="$(git diff --name-only "$BASE_SHA"...HEAD)"
          check_pair() {
            lock="$1"; manifest="$2"
            if echo "$changed" | grep -qx "$lock" && ! echo "$changed" | grep -qx "$manifest"; then
              echo "::error::$lock changed but $manifest did not. Lockfile-only changes are unreviewed dependency-resolution drift (raw update command, mismatched tool version). Revert the lockfile, or if this is an intentional refresh (security advisory, lockfile repair), add the 'lockfile-refresh' label with a justification in the PR description."
              exit 1
            fi
          }
          check_pair pnpm-lock.yaml package.json
          check_pair package-lock.json package.json
          check_pair yarn.lock package.json
          check_pair uv.lock pyproject.toml
          check_pair poetry.lock pyproject.toml
          check_pair Cargo.lock Cargo.toml
          check_pair go.sum go.mod
```

Keep only the pairs matching the repo's stack; in monorepos, repeat `check_pair` per workspace path. The `lockfile-refresh` escape hatch mirrors the `diff-limit-exempt` pattern: label skips the check, reviewers enforce the justification.

---

## § Toolchain pinning

<!-- eng-init template version: 2026-06-10 -->

Why: when the agent's local toolchain drifts from CI's (Node 22 locally, Node 20 in CI; different formatter versions), checks pass in one place and fail in the other — every mismatch burns fix-and-recheck cycles on phantom failures, and at 3 cycles the iteration gate forces a stop. Pin once; both the agent and CI read the same pin.

Path: `.tool-versions` (mise and asdf both read it; CI `{{SETUP_STEPS}}` should source versions from here, not hardcode them):

```
# .tool-versions — single toolchain pin for humans, agents, and CI (mise/asdf).
{{RUNTIME_NAME}} {{RUNTIME_VERSION}}
{{PACKAGE_MANAGER_NAME}} {{PACKAGE_MANAGER_VERSION}}
just {{JUST_VERSION}}
```

Examples: `nodejs 20.18.1` / `pnpm 9.15.4`; `python 3.12.8` / `uv 0.5.21`; `golang 1.23.4`; `rust 1.83.0`; `java temurin-21.0.5+11`.

Path: `.devcontainer/devcontainer.json` — minimal, for cloud agents and onboarding (readiness: `devcontainer`):

```json
{
  "name": "{{PROJECT_NAME}}",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "features": {
    "ghcr.io/devcontainers/features/{{RUNTIME_FEATURE}}:1": {
      "version": "{{RUNTIME_VERSION}}"
    }
  },
  "postCreateCommand": "{{SETUP_COMMAND}}",
  "customizations": {
    "vscode": {
      "extensions": [{{EDITOR_EXTENSIONS_LIST}}]
    }
  }
}
```

Keep `{{RUNTIME_VERSION}}` identical in `.tool-versions`, the devcontainer, and CI `{{SETUP_STEPS}}` — three places stating one truth is acceptable only because the liveness/CI jobs exercise all three; divergence surfaces as a red build, not silent drift.

---

## § CODEOWNERS critical paths

<!-- eng-init template version: 2026-06-10 -->

Critical paths (Q7.6: auth, payments, permissions, data deletion, migrations, security-sensitive code, concurrency, public APIs) require human white-box review — gray-box delegation does not apply there. This file mirrors the AGENTS.md `## Critical Paths` table (rendered immediately before `## Agent Operating Rules`); keep the two in sync, with AGENTS.md as the prose source and this file as the enforcement.

Path: `.github/CODEOWNERS`:

```
# .github/CODEOWNERS — critical paths require named human review.
# Mirrors AGENTS.md ## Critical Paths (Q7.6). Last match wins.

*                       {{DEFAULT_OWNERS}}

# Critical paths — white-box human review required:
{{CRITICAL_PATH_1}}     {{OWNERS_1}}
{{CRITICAL_PATH_2}}     {{OWNERS_2}}
{{CRITICAL_PATH_3}}     {{OWNERS_3}}
```

Example rows: `/src/auth/ @{{ORG}}/security`, `/migrations/ @{{ORG}}/data`, `/src/payments/ @{{ORG}}/payments-leads`, `/.github/workflows/ @{{ORG}}/platform`.

Enforcement honesty: CODEOWNERS only blocks merges when branch protection requires code-owner review — that is a server-side setting, not a file. Record it in the AGENTS.md Enforcement Index as `gate — documented external setting` with the exact command to apply, e.g.:

```bash
gh api -X PUT "repos/{{ORG}}/{{REPO}}/branches/main/protection" \
  --input - <<'EOF'
{
  "required_pull_request_reviews": { "require_code_owner_reviews": true, "required_approving_review_count": 1 },
  "required_status_checks": null,
  "enforce_admins": false,
  "restrictions": null
}
EOF
```

Without that setting, CODEOWNERS is `review-only` (a reviewer-routing hint). Never list it as `gate` in the Enforcement Index until the protection is applied.

---

## § Large-refactor work-unit templates

<!-- eng-init template version: 2026-06-11 -->

Render only when question-bank Dimension 9 activates the large-refactor overlay and Q9.7 selects local task files. Do not write these for ordinary initialization runs.

Path: `agent_tasks/README.md`

```markdown
# Agent Refactor Tasks

This directory coordinates large-refactor work units. Claim exactly one task before editing. Do not duplicate another agent's claimed failure.

## Workflow

1. Pick one unclaimed task.
2. Fill `Owner` and `Started`.
3. **Discover**: reproduce the failure with the `Reproduce` command, compare against the `Reference`, and write root-cause evidence in `Notes`.
4. **Fix**: edit only paths listed in `Allowed files` after discovery evidence exists.
5. **Review**: compare the result against the `Reference`; reject untested divergence, weakened compare tests, fallback, or out-of-scope files.
6. Run the `Done when` verifier.
7. Record discovery, fix, and review evidence in `Notes`.

## Forbidden moves

- Do not weaken compare tests, snapshots, or fixtures to get green.
- Do not shell out to the legacy/reference implementation except from explicit oracle commands.
- Do not add silent fallback to old code.
- Do not keep old and new production paths live unless the cutover policy allows it.
```

Path: `agent_tasks/task-template.md`

```markdown
# {{TASK_ID}}

Goal: {{ONE_OBSERVABLE_BEHAVIOR}} (one failing case, one module, or one compatibility surface only)
Reference: {{REFERENCE_FILE_DOC_TEST_OR_UPSTREAM}}
Reproduce: `{{REPRODUCE_COMMAND}}`
Allowed files:
- `{{PATH_1}}`
- `{{PATH_2}}`
Forbidden moves:
- weaken-compare-tests
- shell-out-to-legacy
- silent-fallback-to-old-code
Done when: `{{VERIFY_COMMAND}}` exits 0 and evidence is recorded below.
Owner: unclaimed
Started: unset

Role evidence:
- Discover:
- Fix:
- Review:

Notes:
-
```

Path: `refactor-status.toml` (optional when Q9.7 selects local task files and the user wants a status dashboard)

```toml
# Refactor status is a dashboard, not an oracle. Verification lives in commands.
[summary]
kind = "{{REFACTOR_KIND}}"
source_of_truth = "{{PRIMARY_REFERENCE}}"
cutover_policy = "{{CUTOVER_POLICY}}"

[[tasks]]
id = "{{TASK_ID}}"
status = "unclaimed" # unclaimed | claimed | blocked | done
owner = ""
verifier = "{{VERIFY_COMMAND}}"
```

### Compare target snippets

Only render a compare target when every command is concrete. A placeholder compare target is phantom verification; record a readiness gap instead. Render the target through the selected dev entry point from Q5.1: Justfile recipe, Makefile target, or package script. The command recorded in `constraints.yaml`, AGENTS.md `## Source of Truth & Refactor Contract`, and AGENTS.md `## Verification Matrix` must use that same selected entry point.

Justfile form:
```just
# Compare final public behavior against golden/reference fixtures.
compare:
    {{COMPARE_COMMAND}}

# Compare compiler/parser/transformer intermediate state or pass dumps.
compare-ir:
    {{COMPARE_IR_COMMAND}}

# Compare public API/schema/CLI contracts.
compare-schema:
    {{COMPARE_SCHEMA_COMMAND}}
```

Makefile form:

```makefile
# Compare final public behavior against golden/reference fixtures.
compare:
	{{COMPARE_COMMAND}}

# Compare compiler/parser/transformer intermediate state or pass dumps.
compare-ir:
	{{COMPARE_IR_COMMAND}}

# Compare public API/schema/CLI contracts.
compare-schema:
	{{COMPARE_SCHEMA_COMMAND}}
```

Package-script form:

```json
{
  "scripts": {
    "compare": "{{COMPARE_COMMAND}}",
    "compare:ir": "{{COMPARE_IR_COMMAND}}",
    "compare:schema": "{{COMPARE_SCHEMA_COMMAND}}"
  }
}
```

Map rendered targets into `constraints.yaml refactor_contract.source_of_truth[*].verification`, AGENTS.md `## Source of Truth & Refactor Contract`, and AGENTS.md `## Verification Matrix`.

---

## § Observability snippets

<!-- eng-init template version: 2026-06-11 -->

Dimension 8 promises structured logging and distributed tracing artifacts. This section provides the concrete templates; without them the enforcement is phantom — the promise exists but nothing can be wired.

### Per-stack logger-lint rule values for `{{LOGGER_LINT_RULE}}`

Prevent raw `print`/`console.log` leaking into production code by wiring a lint rule at the enforcement layer rather than relying on review.

**Node/TypeScript (ESLint):**

```json
// .eslintrc.json excerpt — add to "rules":
"no-console": ["error", { "allow": ["warn", "error"] }]
```

Only `console.warn` and `console.error` are allowed; `console.log`/`console.info`/`console.debug` are errors. Structured logger calls (e.g. `logger.info(...)`) are unaffected.

**Python (ruff):**

```toml
# pyproject.toml excerpt — add to [tool.ruff.lint]:
select = ["T201", "T203"]
# T201: print() found; T203: pprint() found.
# Use a structured logger (structlog, logging) instead.
```

**Go (golangci-lint — forbidigo):**

```yaml
# .golangci.yml excerpt — add under linters-settings:
forbidigo:
  forbid:
    - p: "^fmt\\.Print(ln|f)?$"
      msg: "use structured logger (slog/zap/zerolog), not fmt.Print*"
```

**Rust (Clippy):**

```toml
# .clippy.toml or deny attribute in lib.rs:
# Add to #![deny(...)] at the crate root:
#   clippy::print_stdout,
#   clippy::print_stderr
# Or in clippy.toml:
disallowed-macros = ["std::println", "std::print", "std::eprintln", "std::eprint"]
```

**Java (Checkstyle — Regexp):**

```xml
<!-- checkstyle.xml excerpt — add inside <module name="TreeWalker">: -->
<module name="RegexpSinglelineJava">
  <property name="format" value="System\.(out|err)\.(print|println|printf)"/>
  <property name="message" value="Use a structured logger (SLF4J/Logback), not System.out/err"/>
  <property name="ignoreComments" value="true"/>
</module>
```

### OTel init snippets

#### Node/TypeScript — `{{OTEL_INIT_PATH}}` (e.g. `src/instrumentation.ts`)

```ts
// src/instrumentation.ts — OpenTelemetry SDK init. Import before any app code.
// deps: @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  serviceName: '{{SERVICE_NAME}}',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
```

Register via `NODE_OPTIONS='--require ./src/instrumentation.js'` or `--import` (ESM). Add `{{OTEL_INIT_PATH}}` to `constraints.yaml` `verification.otel_init` so the liveness check can confirm the file exists.

#### Python — OTel init (e.g. `src/{{APP}}/otel.py`)

```python
# src/{{APP}}/otel.py — OpenTelemetry SDK init. Call configure_otel() at process start.
# deps: opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

def configure_otel(service_name: str = "{{SERVICE_NAME}}") -> None:
    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(
        endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318/v1/traces")
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
```

Call `configure_otel()` in the application entry point before the first request is handled.

#### Other stacks

Go, Rust, and Java OTel wiring is review-only until a validated snippet exists. Use the official SDK docs as the reference; do not emit untested boilerplate. Record the gap in AGENTS.md `## Important Development Notes` as `OTel wiring: not templated — wire manually per https://opentelemetry.io/docs/languages/<stack>/`.
