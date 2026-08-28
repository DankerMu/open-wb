"""Close invariants that a mutation sweep proved nothing was testing.

`scripts/mutation_sweep.py` neuters each failable branch in turn and reruns the
suite; 45 survived, meaning those rules were promises with no proof they reject
anything. This file closes the ones on the default execution path — the branches
that fire on an ordinary `check_rendered_harness.py <repo>` run and on the audit
and repair validators.

Every test names the branch it covers so a future sweep can attribute it, and
each cluster keeps an acceptance case: a rejection-only test cannot tell a
working check from one that fails on everything.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, SKILL / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


crh = _load("check_rendered_harness")
crr = _load("check_readiness_registry")
score_mod = _load("score_readiness_report")
repair_mod = _load("validate_readiness_repair")
REGISTRY = SKILL / "references" / "readiness-registry.yaml"
REGISTRY_DATA = score_mod.parse_registry(REGISTRY)

GOOD_AGENTS = """# AGENTS.md

## Code Canonicality

One implementation per concept.

## Verification Matrix

| Surface | Command |
|---|---|
| unit tests | `just test` |

## Enforcement Index

| Rule | Where it lives | Checked by | Level |
|---|---|---|---|
| lint clean | `eslint.config.mjs` | `just test` | block |
"""


def repo_with(tmp_path, agents=GOOD_AGENTS, justfile="test:\n\techo ok\n", **files):
    tmp_path.joinpath("AGENTS.md").write_text(agents, encoding="utf-8")
    if justfile is not None:
        tmp_path.joinpath("justfile").write_text(justfile, encoding="utf-8")
    tmp_path.joinpath("eslint.config.mjs").write_text("export default []\n", encoding="utf-8")
    for name, body in files.items():
        tmp_path.joinpath(name.replace("__", ".")).write_text(body, encoding="utf-8")
    return tmp_path


def check(tmp_path, monkeypatch, capsys, *flags):
    monkeypatch.setattr(sys, "argv", ["check_rendered_harness.py", str(tmp_path), *flags])
    rc = crh.main()
    captured = capsys.readouterr()
    # Violations go to stderr per gate-quality-contract.md's protocol;
    # the success summary goes to stdout. Assertions care about content,
    # not stream, so both are returned.
    return rc, captured.out + captured.err


# ---------------------------------------------------------------------------
# check_rendered_harness default path
# ---------------------------------------------------------------------------

def test_default_path_accepts_a_conforming_repo(tmp_path, monkeypatch, capsys):
    """Acceptance anchor for every rejection in this file."""
    rc, out = check(repo_with(tmp_path), monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 0, out


def test_missing_repo_path_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: repo path does not exist."""
    rc, out = check(tmp_path / "nope", monkeypatch, capsys)
    assert rc == 1 and "does not exist" in out, out


def test_agents_line_budget_is_enforced(tmp_path, monkeypatch, capsys):
    """Branch: AGENTS.md has N lines, exceeds the budget."""
    fat = GOOD_AGENTS + "\n" + "\n".join(f"filler line {i}" for i in range(400))
    rc, out = check(repo_with(tmp_path, agents=fat), monkeypatch, capsys, "--max-agents-lines", "50")
    assert rc == 1 and "exceeds 50" in out, out


def test_required_section_absence_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: AGENTS.md missing required section."""
    rc, out = check(repo_with(tmp_path), monkeypatch, capsys, "--require-section", "Critical Paths")
    assert rc == 1 and "missing required section: Critical Paths" in out, out


def test_preserved_user_section_absence_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: preserved user-owned section missing — the re-run overwrite guard."""
    rc, out = check(repo_with(tmp_path), monkeypatch, capsys,
                    "--require-preserved-section", "Team Notes")
    assert rc == 1 and "preserved user-owned section missing" in out, out


def test_no_runnable_entry_point_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: a Verification Matrix exists but no entry point has runnable targets."""
    rc, out = check(repo_with(tmp_path, justfile=None), monkeypatch, capsys)
    assert rc == 1 and "no runnable targets" in out, out


def test_matrix_with_no_supported_command_form_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: matrix contains no supported just/make/package-script command."""
    agents = GOOD_AGENTS.replace("`just test`", "run the tests by hand")
    rc, out = check(repo_with(tmp_path, agents=agents), monkeypatch, capsys)
    assert rc == 1 and "no supported" in out, out


def test_mixed_entry_points_without_a_selection_are_reported(tmp_path, monkeypatch, capsys):
    """Branch: matrix mixes just/make without constraints.yaml naming the winner."""
    agents = GOOD_AGENTS.replace("| unit tests | `just test` |",
                                 "| unit tests | `just test` |\n| lint | `make lint` |")
    repo = repo_with(tmp_path, agents=agents)
    repo.joinpath("Makefile").write_text("lint:\n\techo ok\n", encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and "mixes command entry points" in out, out


def test_constraints_command_absent_from_the_matrix_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: constraints.yaml names a command the matrix does not."""
    repo = repo_with(tmp_path, justfile="test:\n\techo ok\nsmoke:\n\techo ok\n")
    repo.joinpath("constraints.yaml").write_text(
        'verification:\n  surfaces:\n    - name: unit\n      command: "just test"\n'
        '    - name: smoke\n      command: "just smoke"\n', encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and "is not present in Verification Matrix" in out, out


def test_matrix_command_not_mirrored_in_constraints_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: the machine-readable mirror drifted from AGENTS.md."""
    agents = GOOD_AGENTS.replace("| unit tests | `just test` |",
                                 "| unit tests | `just test` |\n| smoke | `just smoke` |")
    repo = repo_with(tmp_path, agents=agents, justfile="test:\n\techo ok\nsmoke:\n\techo ok\n")
    repo.joinpath("constraints.yaml").write_text(
        'verification:\n  surfaces:\n    - name: unit\n      command: "just test"\n', encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and "is not mirrored in constraints.yaml" in out, out


@pytest.mark.parametrize(
    "row,expected",
    [
        ("| lint clean | `eslint.config.mjs` |  | block |", "empty checker"),
        ("| lint clean | `eslint.config.mjs` | review-only | block |", "marked as non-blocking"),
        ("| lint clean | `eslint.config.mjs` | somebody looks at it | block |", "no runnable checker"),
    ],
    ids=["empty-checker", "non-blocking-checker", "unrunnable-checker"],
)
def test_enforcement_index_row_quality_is_enforced(tmp_path, monkeypatch, capsys, row, expected):
    """Branches: block-level rows with an empty, non-blocking, or unrunnable checker."""
    agents = GOOD_AGENTS.replace("| lint clean | `eslint.config.mjs` | `just test` | block |", row)
    rc, out = check(repo_with(tmp_path, agents=agents), monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 1 and expected in out, out


def test_enforcement_index_with_no_block_rows_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: an Enforcement Index where nothing is actually gated."""
    agents = GOOD_AGENTS.replace("| lint clean | `eslint.config.mjs` | `just test` | block |",
                                 "| lint clean | `eslint.config.mjs` | `just test` | review-only |")
    rc, out = check(repo_with(tmp_path, agents=agents), monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 1 and "no block/gate rows" in out, out


# ---------------------------------------------------------------------------
# check_readiness_registry structural branches
# ---------------------------------------------------------------------------

def registry_text(rows: str, top: str = "schema_version: 1\nscoring:\n  x: 1\ncontrol_plane_layers:\n  - Memory\ncriteria:\n") -> str:
    return top + rows


def one_row(cid="criterion_00", **over) -> str:
    fields = {"level": "2", "scope": "repository", "skippable": "false", "fixability": "A",
              "layer": "Memory", "artifact": "AGENTS.md", "validator": "it exists",
              "rescore_evidence": f"{cid}=1/1 when present"}
    fields.update(over)
    body = "".join(f"    {k}: {v}\n" for k, v in fields.items())
    return f"  - id: {cid}\n{body}"


def write_registry(tmp_path, rows: str) -> Path:
    p = tmp_path / "reg.yaml"
    p.write_text(registry_text(rows), encoding="utf-8")
    return p


ALL_ROWS = "".join(one_row(f"criterion_{i:02d}") for i in range(14))


def test_registry_accepts_a_conforming_file(tmp_path):
    errors, _ = crr.validate(write_registry(tmp_path, ALL_ROWS))
    assert errors == [], errors


@pytest.mark.parametrize(
    "rows,top,expected",
    [
        (ALL_ROWS, "scoring:\n  x: 1\ncontrol_plane_layers:\n  - Memory\ncriteria:\n", "missing top-level field schema_version"),
        ("".join(one_row(f"criterion_{i:02d}") for i in range(5)), None, "expected at least 12 criteria"),
        (ALL_ROWS + one_row("Criterion-With-Caps"), None, "invalid criterion id"),
        (ALL_ROWS + "  - id: criterion_99\n    level: 2\n    scope: repository\n", None, "missing"),
        (ALL_ROWS + one_row("criterion_99", rescore_evidence="placeholder"), None, "must not be placeholder text"),
    ],
    ids=["missing-top-level", "too-few-criteria", "bad-id-format", "missing-field", "placeholder-evidence"],
)
def test_registry_rejects_each_structural_violation(tmp_path, rows, top, expected):
    p = tmp_path / "reg.yaml"
    p.write_text(registry_text(rows) if top is None else top + rows, encoding="utf-8")
    errors, _ = crr.validate(p)
    assert any(expected in e for e in errors), errors


# ---------------------------------------------------------------------------
# score_readiness_report / validate_readiness_repair type branches
# ---------------------------------------------------------------------------

def base_report() -> dict:
    return {
        "applications": [{"name": "api"}],
        "score": {"applications_identified": 1, "average": 1.0},
        "criteria": [{
            "id": "agents_md", "denominator": 1, "numerator": 1, "status": "passing",
            "evidence": "exists", "validator": "file check", "rescore_rule": "1/1",
        }],
        "configured_but_not_blocking": [],
    }


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda r: r.update(criteria={"not": "a list"}), "criteria must be a list"),
        (lambda r: r["criteria"][0].update(numerator="one"), "numerator must be number or null"),
        (lambda r: r["criteria"][0].update(denominator=0), "denominator must be"),
        (lambda r: r["score"].update(average="high"), "score.average must be numeric"),
        (lambda r: r.update(configured_but_not_blocking=["never_declared"]), "missing from criteria"),
    ],
    ids=["criteria-not-list", "numerator-not-numeric", "denominator-zero",
         "average-not-numeric", "partial-id-not-in-criteria"],
)
def test_scorer_rejects_each_type_violation(mutate, expected):
    report = base_report()
    mutate(report)
    _, errors = score_mod.score(report, REGISTRY_DATA)
    assert any(expected in e for e in errors), errors


def base_handoff() -> dict:
    return {
        "schema_version": 1, "requested_signal": "s", "matched_criterion": "guardrail_self_test",
        "fixability": "A", "pre_state": {"status": "failing", "evidence": "e"},
        "allowed_files": ["x"], "validator": {"command": "c", "exit_code": 0, "evidence": "e"},
        "post_state": {"status": "passing", "rescore_evidence": "r"}, "decision": "repaired",
    }


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda h: h["post_state"].update(status="failing"), "requires passing/partial/skipped post_state"),
        (lambda h: (h.update(decision="no_op_already_passing"),
                    h["pre_state"].update(status="failing")), "requires pre and post passing"),
    ],
    ids=["repaired-with-failing-post", "noop-with-failing-pre"],
)
def test_repair_rejects_each_decision_state_violation(mutate, expected):
    handoff = base_handoff()
    mutate(handoff)
    errors = repair_mod.validate(handoff, REGISTRY_DATA)
    assert any(expected in e for e in errors), errors


# ---------------------------------------------------------------------------
# Round 2 of the sweep: the flag-gated and overlay-gated branches. These fire
# only under --forbid-root-backups, --require-generated-section-registry,
# --require-rehabilitation-state, and --require-refactor-contract/--require-compare,
# which is exactly why nothing reached them.
# ---------------------------------------------------------------------------

def test_scorer_rejects_a_non_object_criteria_row():
    """Branch: criteria[i] must be an object.

    Added while fixing a crash in this same function and promptly left untested —
    caught by the next sweep. A new guard needs its own rejection sample, or it
    is the class of rule it was written to prevent.
    """
    report = base_report()
    report["criteria"] = ["a string, not an object"]
    _, errors = score_mod.score(report, REGISTRY_DATA)
    assert any("must be an object" in e for e in errors), errors


def test_missing_agents_md_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: missing required file."""
    tmp_path.joinpath("justfile").write_text("test:\n\techo ok\n", encoding="utf-8")
    rc, out = check(tmp_path, monkeypatch, capsys)
    assert rc == 1 and "missing required file" in out, out


def test_root_backup_artifact_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: root-level backup/copy artifact forbidden — git is the rollback path."""
    repo = repo_with(tmp_path)
    repo.joinpath("AGENTS.md.bak.20260810").write_text("old", encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys, "--forbid-root-backups")
    assert rc == 1 and "backup/copy artifact is forbidden" in out, out


def test_root_backups_flag_accepts_a_clean_root(tmp_path, monkeypatch, capsys):
    rc, out = check(repo_with(tmp_path), monkeypatch, capsys, "--forbid-root-backups")
    assert rc == 0, out


@pytest.mark.parametrize(
    "entrypoint,extra_target,expected",
    [
        ("brew install stuff", None, "is not a supported command"),
        ("just nonexistent", None, "has no matching recipe target"),
    ],
    ids=["unsupported-form", "no-target"],
)
def test_selected_command_entrypoint_is_validated(tmp_path, monkeypatch, capsys, entrypoint, extra_target, expected):
    """Branches: the constraints.yaml-selected entry point must be real."""
    repo = repo_with(tmp_path)
    repo.joinpath("constraints.yaml").write_text(
        f'command_entrypoint: "{entrypoint}"\n', encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and expected in out, out


def test_conflicting_selected_entry_points_are_reported(tmp_path, monkeypatch, capsys):
    """Branch: two different entry-point kinds selected at once."""
    repo = repo_with(tmp_path)
    repo.joinpath("Makefile").write_text("lint:\n\techo ok\n", encoding="utf-8")
    repo.joinpath("constraints.yaml").write_text(
        'command_entrypoint: "just test"\nother:\n  command_entrypoint: "make lint"\n', encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and "conflicting selected command entry points" in out, out


def test_matrix_command_off_the_selected_entry_point_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: a matrix command that ignores the selected entry point."""
    agents = GOOD_AGENTS.replace("| unit tests | `just test` |",
                                 "| unit tests | `just test` |\n| lint | `make lint` |")
    repo = repo_with(tmp_path, agents=agents)
    repo.joinpath("Makefile").write_text("lint:\n\techo ok\n", encoding="utf-8")
    repo.joinpath("constraints.yaml").write_text('command_entrypoint: "just test"\n', encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and "does not use selected" in out, out


def test_selected_entry_point_without_runnable_targets_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: the selected surface exists but holds no targets."""
    repo = repo_with(tmp_path, justfile="# no recipes here\n")
    repo.joinpath("constraints.yaml").write_text('command_entrypoint: "just test"\n', encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and "no runnable targets" in out, out


def test_runtime_placeholder_outside_a_consumer_file_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: a `{{lowercase}}` runtime placeholder in a file that may not carry one."""
    repo = repo_with(tmp_path)
    repo.joinpath("constraints.yaml").write_text("note: {{some_runtime_value}}\n", encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and "runtime placeholder" in out, out


# --- generated-section registry overlay -----------------------------------

REGISTRY_BLOCK = """generated_sections:
  preserve_unknown_sections: true
  agents_md:
    - title: "Code Canonicality"
    - title: "Verification Matrix"
    - title: "Enforcement Index"
"""


def test_generated_section_registry_accepts_a_matching_registry(tmp_path, monkeypatch, capsys):
    repo = repo_with(tmp_path)
    repo.joinpath("constraints.yaml").write_text(REGISTRY_BLOCK, encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys, "--require-generated-section-registry")
    assert rc == 0, out


@pytest.mark.parametrize(
    "block,expected",
    [
        ("verification:\n  surfaces: []\n", "missing generated_sections registry"),
        ("generated_sections:\n  preserve_unknown_sections: true\n  agents_md: []\n", "no registered titles"),
        (REGISTRY_BLOCK.replace("preserve_unknown_sections: true", "preserve_unknown_sections: false"),
         "preserve unknown sections"),
        (REGISTRY_BLOCK.replace('    - title: "Enforcement Index"\n', ""), "is not registered in generated_sections"),
        (REGISTRY_BLOCK + '    - title: "Observability"\n', "not present in AGENTS.md"),
    ],
    ids=["no-registry", "empty-registry", "preserve-flag-off", "section-unregistered", "registered-but-absent"],
)
def test_generated_section_registry_rejects_each_violation(tmp_path, monkeypatch, capsys, block, expected):
    repo = repo_with(tmp_path)
    repo.joinpath("constraints.yaml").write_text(block, encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys, "--require-generated-section-registry")
    assert rc == 1 and expected in out, out


# --- rehabilitation overlay ------------------------------------------------

REHAB_AGENTS = GOOD_AGENTS + "\n## Rehabilitation gate\n\nNo broad refactor before the verifier exists.\n"
REHAB_BLOCK = """rehabilitation:
  active: true
  phase: "stabilize"
  baseline_frozen: true
  command_entrypoint: "just test"
  runtime_verifier: "just test"
  broad_refactor_allowed: false
  work_unit_protocol: "one failure per unit"
"""


def test_rehabilitation_state_accepts_a_complete_block(tmp_path, monkeypatch, capsys):
    repo = repo_with(tmp_path, agents=REHAB_AGENTS)
    repo.joinpath("constraints.yaml").write_text(REHAB_BLOCK, encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys, "--require-rehabilitation-state")
    assert rc == 0, out


@pytest.mark.parametrize(
    "block,agents,expected",
    [
        ("verification:\n  surfaces: []\n", None, "missing rehabilitation state"),
        (REHAB_BLOCK.replace('command_entrypoint: "just test"', 'command_entrypoint: "none"'), None,
         "must name a concrete selected-entry command"),
        (REHAB_BLOCK.replace("active: true", "active: false"), None, "must be active"),
        (REHAB_BLOCK.replace("  broad_refactor_allowed: false\n", ""), None, "missing broad_refactor_allowed"),
        (REHAB_BLOCK.replace("baseline_frozen: true", "baseline_frozen: false")
                    .replace("broad_refactor_allowed: false", "broad_refactor_allowed: true"), None,
         "cannot allow broad refactor"),
        (REHAB_BLOCK.replace('runtime_verifier: "just test"', 'runtime_verifier: "curl example.com"'), None,
         "is not a supported command"),
        (REHAB_BLOCK.replace('runtime_verifier: "just test"', 'runtime_verifier: "just ghost"'), None,
         "has no matching recipe target"),
        (REHAB_BLOCK.replace('  phase: "stabilize"\n', ""), None, "missing key: phase"),
        (REHAB_BLOCK, GOOD_AGENTS, "missing Rehabilitation gate"),
    ],
    ids=["absent", "no-entrypoint", "inactive", "no-broad-flag", "refactor-before-baseline",
         "verifier-unsupported", "verifier-no-target", "missing-phase", "no-agents-gate"],
)
def test_rehabilitation_state_rejects_each_violation(tmp_path, monkeypatch, capsys, block, agents, expected):
    repo = repo_with(tmp_path, agents=agents or REHAB_AGENTS)
    repo.joinpath("constraints.yaml").write_text(block, encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys, "--require-rehabilitation-state")
    assert rc == 1 and expected in out, out


# --- refactor contract overlay ---------------------------------------------

SOT_AGENTS = GOOD_AGENTS + """
## Source of Truth & Refactor Contract

| Surface | Canonical source | Oracle command |
|---|---|---|
| parity | legacy/ | `just test` |
"""


def test_refactor_contract_accepts_a_contract_with_an_oracle(tmp_path, monkeypatch, capsys):
    rc, out = check(repo_with(tmp_path, agents=SOT_AGENTS), monkeypatch, capsys,
                    "--require-refactor-contract", "--require-compare")
    assert rc == 0, out


@pytest.mark.parametrize(
    "agents,expected",
    [
        (GOOD_AGENTS, "missing ## Source of Truth & Refactor Contract"),
        (GOOD_AGENTS + "\n## Source of Truth & Refactor Contract\n\nLegacy is canonical.\n",
         "at least one oracle/compare command"),
        (SOT_AGENTS.replace("| parity | legacy/ | `just test` |", "| parity | legacy/ | `just parity` |"),
         "is not present in Verification Matrix"),
    ],
    ids=["no-contract", "contract-without-oracle", "oracle-absent-from-matrix"],
)
def test_refactor_contract_rejects_each_violation(tmp_path, monkeypatch, capsys, agents, expected):
    repo = repo_with(tmp_path, agents=agents, justfile="test:\n\techo ok\nparity:\n\techo ok\n")
    rc, out = check(repo, monkeypatch, capsys, "--require-refactor-contract", "--require-compare")
    assert rc == 1 and expected in out, out


# ---------------------------------------------------------------------------
# Final three survivors. Each needed a fixture that isolates it from a sibling
# branch emitting a similar message — the shadowing pattern that hid the first
# two holes this sweep found.
# ---------------------------------------------------------------------------

def test_generated_registry_with_entries_but_no_parseable_titles_is_reported(tmp_path, monkeypatch, capsys):
    """Branch: agents_md has list items, none of which parse as `- title: "X"`.

    Distinct from the empty-list branch above, which shares its message. A
    registry written with bare strings looks populated and registers nothing.
    """
    repo = repo_with(tmp_path)
    repo.joinpath("constraints.yaml").write_text(
        "generated_sections:\n  preserve_unknown_sections: true\n"
        '  agents_md:\n    - "Code Canonicality"\n    - "Verification Matrix"\n',
        encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys, "--require-generated-section-registry")
    assert rc == 1 and "contains no registered titles" in out, out


def test_selected_entry_point_absent_while_another_surface_exists(tmp_path, monkeypatch, capsys):
    """Branch: constraints.yaml selects `make`, but only a justfile exists.

    The sibling branch (no surface at all has targets) fires when the repo has
    nothing runnable; this one fires when something runs but not the selected
    one, which is the drift that matters after an entry-point switch.
    """
    agents = GOOD_AGENTS.replace("| unit tests | `just test` |", "| unit tests | `make test` |")
    repo = repo_with(tmp_path, agents=agents)  # justfile only, no Makefile
    repo.joinpath("constraints.yaml").write_text('command_entrypoint: "make test"\n', encoding="utf-8")
    rc, out = check(repo, monkeypatch, capsys)
    assert rc == 1 and "selected `make` entry point has no runnable targets" in out, out


def test_source_of_truth_oracle_in_the_matrix_but_without_a_target(tmp_path, monkeypatch, capsys):
    """Branch: a Source of Truth oracle present in the matrix whose target is gone.

    Isolated from the not-present-in-matrix sibling by listing the command in
    both places; only the missing recipe remains.
    """
    agents = (GOOD_AGENTS.replace("| unit tests | `just test` |",
                                  "| unit tests | `just test` |\n| parity | `just compare` |")
              + "\n## Source of Truth & Refactor Contract\n\n"
                "| Surface | Canonical source | Oracle command |\n|---|---|---|\n"
                "| parity | legacy/ | `just compare` |\n")
    repo = repo_with(tmp_path, agents=agents, justfile="test:\n\techo ok\n")  # no `compare` recipe
    rc, out = check(repo, monkeypatch, capsys, "--require-refactor-contract", "--require-compare")
    assert rc == 1, out
    assert "Source of Truth command `just compare` has no matching recipe target" in out, out


# ---------------------------------------------------------------------------
# Error-message protocol conformance. references/gate-quality-contract.md
# publishes a shape every gate owes; the four gates each printed something
# different and none of them matched. The contract is now implemented once in
# scripts/gate_output.py, and this pins it in both directions.
# ---------------------------------------------------------------------------

gate_output = _load("gate_output")


def test_protocol_violation_shape(capsys):
    """Title line on stderr naming the gate and the count; violations indented two spaces."""
    rc = gate_output.report("some-gate", ["a.md:3  expected \"x\", got \"y\"", "b.md:9  missing z"], "unused")
    captured = capsys.readouterr()
    assert rc == 1
    assert captured.out == "", "violations must not go to stdout"
    lines = captured.err.splitlines()
    assert lines[0] == "some-gate: 2 violation(s) found:"
    assert all(line.startswith("  ") for line in lines[1:]), lines
    assert 'expected "x", got "y"' in captured.err


def test_protocol_success_shape(capsys):
    """Silent green is forbidden: the summary names what was checked, on stdout."""
    rc = gate_output.report("some-gate", [], "12 files checked, all conform")
    captured = capsys.readouterr()
    assert rc == 0
    assert captured.out.strip() == "some-gate: 12 files checked, all conform"
    assert captured.err == ""


# Derived, not hand-copied: a transcribed list of gates drifts the moment one is
# added, and this one had already drifted — check_skill_content.py was missing
# from the first version of this parametrization while honouring the contract.
GATE_SCRIPTS = sorted(
    p.name for p in (SKILL / "scripts").glob("*.py")
    if p.name.startswith(("check_", "score_", "validate_"))
)


@pytest.mark.parametrize("script", GATE_SCRIPTS)
def test_usage_error_is_exit_two_not_one(script):
    """A usage error must never read as 'checked and found a violation'.

    The protocol's third exit code is delivered by argparse rather than a helper —
    an exported entry point with no callers is the speculative generality this
    skill tells target repos to delete. What matters is the observable contract,
    so it is asserted on the real CLIs: a bad invocation exits 2, and 2 is
    distinguishable from the 1 that means a genuine violation.
    """
    import subprocess
    proc = subprocess.run([sys.executable, str(SKILL / "scripts" / script), "--not-a-real-flag"],
                          capture_output=True, text=True)
    assert proc.returncode == 2, f"{script} exited {proc.returncode} on a usage error, expected 2"


@pytest.mark.parametrize("gate_name", [
    "check-rendered-harness", "check-readiness-registry",
    "score-readiness-report", "validate-readiness-repair", "check-skill-content",
])
def test_every_gate_reports_through_the_shared_protocol(gate_name):
    """No gate keeps a private output format.

    Each of the five previously printed its own shape (`FAIL `, `ERROR: `,
    `::error::`, `PASS ...`). Naming the gate in the shared helper is what makes
    the output greppable; a gate that stops using the helper reintroduces the
    divergence this closed.
    """
    sources = "\n".join((SKILL / "scripts" / f"{n}.py").read_text() for n in [
        "check_rendered_harness", "check_readiness_registry",
        "score_readiness_report", "validate_readiness_repair", "check_skill_content"])
    assert f'"{gate_name}"' in sources, f"{gate_name} does not report through gate_output"
    for legacy in ('print(f"FAIL ', 'print(f"ERROR: ', 'print("::error::'):
        assert legacy not in sources, f"legacy output format still present: {legacy}"


# ---------------------------------------------------------------------------
# Content-invariant regexes are themselves rules, and inherit the rule's
# obligation. P2-R30 guards a secret-leak prohibition; its first draft matched
# the token near any negation, so "pull_request_target is never a risk" passed
# while inverting the rule. The proof of the fix lived in a throwaway script and
# not in the repo — the exact gap postmortem 0002 instance 5 names. It lives here
# now.
# ---------------------------------------------------------------------------

def _p2r30_pattern() -> str:
    cases = json.loads((SKILL / "evals" / "content-checks.json").read_text())["cases"]
    checks = [c["checks"] for c in cases if c["id"] == "P2-R30-ci-secret-conventions"][0]
    return checks[0]["pattern"]


@pytest.mark.parametrize(
    "text,should_match",
    [
        ("- Workflows that consume secrets never use `pull_request_target` (leak vector).", True),
        ("- Secret-consuming workflows must not use `pull_request_target`.", True),
        ("- `pull_request_target` is never a risk; use it freely for secret workflows.", False),
        ("- Use `pull_request_target` for secret workflows.", False),
        ("- Never do that. Consider `pull_request_target` when convenient.", False),
    ],
    ids=["canonical-prohibition", "alternate-phrasing", "inverted-keeping-negation",
         "plain-inversion", "negation-drifted-away"],
)
def test_secret_workflow_invariant_requires_the_prohibition_to_govern_the_verb(text, should_match):
    """The negation must govern *using* the token, not merely sit within 80 characters of it."""
    import re as _re
    assert bool(_re.search(_p2r30_pattern(), text, _re.I)) is should_match, text


# ---------------------------------------------------------------------------
# The compensating-control pairing. check_canonicality_first deliberately
# tolerates absence so a repair on a user-owned AGENTS.md is not forced to
# reorder content eng-init does not own; presence is meant to be required by the
# Stage 5 command's --require-section flag. That docstring claimed a pairing
# nobody had wired: the documented command passed only "Verification Matrix", so
# a rendered file with no Code Canonicality section at all went green. Both
# halves are pinned here — the tolerance and the control that compensates for it.
# ---------------------------------------------------------------------------

def test_stage5_command_requires_the_canonicality_section():
    """SKILL.md's validation contract must pass the flag the checker relies on.

    Without it the order check's absence-tolerance has no counterpart, and the
    skill's own P0 section can be missing from a rendered repo that reports pass.
    """
    skill_md = (SKILL / "SKILL.md").read_text()
    assert '--require-section "Code Canonicality"' in skill_md, (
        "the flag the order check's absence-tolerance depends on is not documented anywhere")
    # Scoped, not unconditional: demanding it on every run makes a one-signal
    # repair rewrite an AGENTS.md eng-init does not own — verified to fail on a
    # hand-written file that legitimately has no such section.
    assert "only when eng-init owns the whole file" in skill_md, (
        "the flag must be scoped to the pipelines that own the file, or repair mode widens its own scope")


def test_absent_canonicality_is_rejected_when_the_stage5_flag_is_passed(tmp_path, monkeypatch, capsys):
    """The pairing works end to end: tolerated by default, rejected under the contract."""
    no_canon = GOOD_AGENTS.replace("## Code Canonicality\n\nOne implementation per concept.\n\n", "")
    repo = repo_with(tmp_path, agents=no_canon)
    rc_default, _ = check(repo, monkeypatch, capsys)
    assert rc_default == 0, "absence alone must stay tolerated (user-owned AGENTS.md in repair mode)"
    rc_contract, out = check(repo, monkeypatch, capsys, "--require-section", "Code Canonicality")
    assert rc_contract == 1 and "missing required section: Code Canonicality" in out, out


# ---------------------------------------------------------------------------
# check_doc_claims.py shipped with ten failable branches, no tests, and no place
# in the mutation inventory — a gate written to catch unproven claims, itself
# unproven. Its five rot modes were exercised by hand and the proof left in a
# throwaway script, which is the defect postmortem 0002 instance 7 names. Here
# they are, in the repository.
# ---------------------------------------------------------------------------

doc_claims = _load("check_doc_claims")


def _run_doc_claims(tmp_skill: Path) -> tuple[int, str]:
    """Run the checker against a copied skill tree so mutations touch nothing real."""
    import subprocess
    proc = subprocess.run([sys.executable, str(tmp_skill / "scripts" / "check_doc_claims.py")],
                          capture_output=True, text=True, cwd=tmp_skill)
    return proc.returncode, proc.stdout + proc.stderr


@pytest.fixture
def skill_copy(tmp_path):
    import shutil
    dest = tmp_path / "eng-init"
    shutil.copytree(SKILL, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    return dest


def test_doc_claims_accepts_the_real_tree(skill_copy):
    """Clean side: the committed documentation agrees with the committed artifacts."""
    rc, out = _run_doc_claims(skill_copy)
    assert rc == 0, out


_PM_0002 = "docs/postmortem/0002-verification-scope-overstated-four-times.md"


def _instance_word() -> str:
    """Derive the record's own instance count as a word — never transcribe it.

    These probes used to pin the literal "ten". The moment the record gained an
    eleventh instance every anchor missed, and the probes' own "anchor missing"
    guard fired across three tests. A probe that has to be hand-edited whenever
    the truth changes is exactly the transcription defect it exists to catch, so
    the anchor is computed the same way the gate computes it, and the word table
    is imported from the gate rather than restated.
    """
    import re
    text = (SKILL / _PM_0002).read_text(encoding="utf-8")
    numbers = [int(n) for n in re.findall(r"^## Instances? (\d+)", text, re.M)]
    numbers += [int(b) for _, b in re.findall(r"^## Instances (\d+)[–-](\d+)", text, re.M)]
    return _load("check_doc_claims").WORDS[max(numbers)]


_WORD = _instance_word()


@pytest.mark.parametrize(
    "rel,find,replace,expected",
    [
        ("docs/2026-08-10-first-principles-audit.md",
         "**此后的进展**(截至 2026-08-10 收尾):",
         "**仍未动**:建议 5–11(错误信息协议、事故管线自用……)。",
         "still claims suggestions 5-11 are untouched"),
        ("docs/postmortem/0002-verification-scope-overstated-four-times.md",
         f"overstated {_WORD} times", "overstated seven times",
         "title says something other than"),
        ("docs/postmortem/README.md", f"{_WORD} instances", "nine instances",
         "status line disagrees"),
        ("evals/content-checks.json",
         "0 survive now; the initial count is unknown and at least 45",
         "45 survived initially, 0 now",
         "ruled unverifiable"),
        ("docs/postmortem/0001-stale-bytecode-validated-deleted-code.md",
         "`scripts/mutation_sweep.py` clears caches",
         "`scripts/nonexistent_tool.py` clears caches",
         "which does not exist"),
    ],
    ids=["appendix-b-regressed", "count-vs-title", "count-vs-index",
         "unverifiable-number-returns", "guardrail-names-a-ghost"],
)
def test_doc_claims_rejects_each_rot_mode(skill_copy, rel, find, replace, expected):
    """Each is a way documentation drifts from the artifact it describes.

    The first replays instance 9 verbatim: a fix commit reported syncing this
    section while its anchor did not match, so nothing changed and nothing said so.
    """
    target = skill_copy / rel
    original = target.read_text(encoding="utf-8")
    assert find in original, f"anchor missing in {rel} — the probe would prove nothing"
    target.write_text(original.replace(find, replace), encoding="utf-8")
    rc, out = _run_doc_claims(skill_copy)
    assert rc == 1, f"{rel} rot went undetected:\n{out}"
    assert expected in out, out


@pytest.mark.parametrize(
    "rel,find,replace,expected",
    [
        # L50 — the record loses its own instance headings, so its count is unverifiable.
        ("docs/postmortem/0002-verification-scope-overstated-four-times.md",
         "## Instance", "### Instance",   # all of them: one surviving heading keeps the count derivable
         "cannot verify its own count"),
        # L60 — index row drifts while the status line stays right.
        ("docs/postmortem/README.md",
         f"| Verification scope overstated {_WORD} times",
         "| Verification scope overstated six times",
         "index row disagrees"),
        # L74 — appendix B drops a suggestion's disposition without reverting the whole section.
        ("docs/2026-08-10-first-principles-audit.md",
         "- 建议 **6**(事故管线自用)**已实施**",
         "- (事故管线自用)已实施",
         "disposition of suggestion 6"),
        # L86 — an invariant pins a file that was renamed or deleted.
        ("evals/content-checks.json",
         '"file": "scripts/gate_output.py"',
         '"file": "scripts/gate_output_renamed.py"',
         "which does not exist"),
        # L103 — a postmortem credits a test nobody wrote.
        # The ghost name is assembled at runtime: written as a literal it would
        # appear in this very file, and the gate searches the test sources — the
        # probe would then prove the opposite of what it claims.
        ("docs/postmortem/0001-stale-bytecode-validated-deleted-code.md",
         "`scripts/mutation_sweep.py` clears caches before each suite run",
         "`" + "test_" + "guardrail_" + "nobody_wrote" + "` clears caches before each suite run",
         "which no test defines"),
    ],
    ids=["headings-lost", "index-row-drift", "suggestion-disposition-dropped",
         "invariant-pins-a-ghost-file", "guardrail-credits-a-ghost-test"],
)
def test_doc_claims_rejects_the_remaining_rot_modes(skill_copy, rel, find, replace, expected):
    """The five branches a first pass of probes left unproven, found by mutating the gate itself."""
    target = skill_copy / rel
    original = target.read_text(encoding="utf-8")
    assert find in original, f"anchor missing in {rel} — the probe would prove nothing"
    target.write_text(original.replace(find, replace), encoding="utf-8")
    rc, out = _run_doc_claims(skill_copy)
    assert rc == 1, f"{rel} rot went undetected:\n{out}"
    assert expected in out, out


# ---------------------------------------------------------------------------
# The recurring defect itself, not another of its instances.
#
# Three times now a hand-maintained list of gates went stale the moment a gate
# was added: the exit-2 conformance list missed check_skill_content.py, the
# mutation inventory missed check_doc_claims.py, and check_doc_claims.py shipped
# with ten unproven branches because nothing noticed it existed. Deriving each
# list fixed each instance. This asserts the property those fixes were reaching
# for: **a gate cannot enter the repository without entering the machinery that
# proves it rejects anything.**
#
# A new gate now fails here on the commit that adds it, which is the only moment
# the omission is cheap to fix.
# ---------------------------------------------------------------------------

def _mutation_targets() -> list[str]:
    sweep = _load("mutation_sweep")
    return list(sweep.TARGETS) + sorted(sweep._NOT_A_GATE)


def test_every_gate_is_inside_the_verification_inventory():
    """Each gate script is mutation-swept or explicitly and deliberately excluded."""
    on_disk = {p.name for p in (SKILL / "scripts").glob("*.py")
               if p.name.startswith(("check_", "score_", "validate_"))}
    accounted = set(_mutation_targets())
    missing = sorted(on_disk - accounted)
    assert not missing, (
        "gate(s) outside the mutation inventory — add them to TARGETS' discovery or name them in "
        f"_NOT_A_GATE with a reason: {missing}"
    )


def test_every_gate_is_named_by_at_least_one_test():
    """A gate no test mentions has no proof it rejects anything.

    Weaker than mutation coverage on purpose: this runs in milliseconds on every
    commit, where the sweep takes minutes and runs on demand. It catches the
    omission, the sweep proves the coverage.
    """
    sources = "\n".join(p.read_text(encoding="utf-8")
                        for p in (SKILL / "scripts" / "tests").glob("test_*.py"))
    unreferenced = sorted(
        p.stem for p in (SKILL / "scripts").glob("*.py")
        if p.name.startswith(("check_", "score_", "validate_")) and p.stem not in sources
    )
    assert not unreferenced, (
        f"gate(s) no test names — write the dual assertion before shipping: {unreferenced}"
    )


# --- The self-test template eng-init installs into target repos -------------
#
# `expect_reject` in references/agent-harness-templates.md is the guardrail
# self-proof every generated repo inherits. It shipped asserting only the exit
# code, with the guard's output sent to /dev/null — so a guard that CRASHED
# (traceback, `set -u` on an unset variable, a syntax error) exited non-zero and
# was reported as a guard that rejected the violation. eng-init had already
# fixed this exact defect in its own selfcheck.sh `smoke_rejects` and left the
# shipped copy broken.
#
# These tests extract the function from the reference file rather than restating
# it, so editing the template is what makes them go red.

def _template_expect_reject() -> str:
    import re
    text = (SKILL / "references" / "agent-harness-templates.md").read_text(encoding="utf-8")
    match = re.search(r"^expect_reject\(\) \{.*?^\}", text, re.S | re.M)
    assert match, "expect_reject() not found in agent-harness-templates.md"
    return match.group(0)


def _run_expect_reject(tmp_path, guard_body: str, reason: str) -> str:
    import subprocess
    script = tmp_path / "probe.sh"
    script.write_text(
        "pass=0; fail=0\n"
        + _template_expect_reject()
        + f"\nguard() {{ {guard_body} }}\n"
        + f'expect_reject "probe" "{reason}" guard\n'
        "echo \"TALLY pass=$pass fail=$fail\"\n",
        encoding="utf-8",
    )
    return subprocess.run(["bash", str(script)], capture_output=True, text=True).stdout


def test_template_self_test_accepts_a_guard_that_names_its_violation(tmp_path):
    out = _run_expect_reject(
        tmp_path, 'echo "  forbidden naming suffix: foo_v2.py" >&2; return 1;',
        "forbidden naming suffix")
    assert "TALLY pass=1 fail=0" in out, out


def test_template_self_test_rejects_a_guard_that_crashed_instead_of_judging(tmp_path):
    """Non-zero alone is not rejection — the reason must appear in the output."""
    out = _run_expect_reject(
        tmp_path, 'echo "Traceback (most recent call last):" >&2; return 1;',
        "forbidden naming suffix")
    assert "TALLY pass=0 fail=1" in out, out
    assert "crash, not rejection" in out, out


def test_template_self_test_still_catches_a_guard_that_accepted_the_violation(tmp_path):
    out = _run_expect_reject(tmp_path, "return 0;", "forbidden naming suffix")
    assert "TALLY pass=0 fail=1" in out, out
    assert "phantom enforcement" in out, out


def test_canonicality_docstring_does_not_overstate_when_the_flag_is_passed():
    """The docstring claimed Stage 5 passes the flag; 820becf made it conditional.

    Second failure of the same sentence (postmortem 0002 instances 6 and 10 are
    the same class). check_doc_claims.py inspects prose files, not code
    docstrings, so nothing else would catch a regression here.
    """
    import inspect
    module = _load("check_rendered_harness")
    doc = inspect.getdoc(module.check_canonicality_first) or ""
    assert "Code Canonicality" in doc, "docstring no longer describes the flag pairing"
    assert "only when eng-init owns" in doc, (
        "check_canonicality_first docstring must state that Stage 5 passes "
        '--require-section "Code Canonicality" only when eng-init owns the whole '
        "AGENTS.md — repair mode deliberately omits it (SKILL.md § Validation contract)"
    )
