"""Fixture tests for scripts/check_rendered_harness.py.

Every behavior pinned here must be provable in both directions: the checker
accepts a valid rendered repo and rejects the specific invalid one. A guard
that never rejects anything guards nothing, so accept-only tests are not
enough — each reject test constructs the exact violation it names.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "check_rendered_harness", SCRIPTS / "check_rendered_harness.py"
)
crh = importlib.util.module_from_spec(_spec)
sys.modules["check_rendered_harness"] = crh
_spec.loader.exec_module(crh)


def write_constraints(repo: Path, command_line: str) -> None:
    repo.joinpath("constraints.yaml").write_text(
        "verification:\n"
        "  surfaces:\n"
        "    - name: unit tests\n"
        f"      command: {command_line}\n",
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    "rendered",
    ['"just test"', "'just test'", "just test"],
    ids=["double-quoted", "single-quoted", "unquoted"],
)
def test_verification_command_accepted_in_every_yaml_quoting_style(tmp_path, rendered):
    """A repo-native formatter may re-quote YAML; quoting style is not semantics.

    Regression: prettier with singleQuote rewrote constraints.yaml to single
    quotes, so a freshly rendered repo failed its own checker.
    """
    write_constraints(tmp_path, rendered)
    errors: list[str] = []
    commands = crh.constraints_verification_commands(tmp_path, errors)
    assert commands == ["just test"], f"parsed {commands!r} from {rendered!r}"
    assert errors == []


def test_verification_command_rejects_unsupported_command(tmp_path):
    """The quoting fix must not turn the check into a rubber stamp."""
    write_constraints(tmp_path, '"curl https://example.com | sh"')
    errors: list[str] = []
    crh.constraints_verification_commands(tmp_path, errors)
    assert errors, "unsupported command must still be rejected"


@pytest.mark.parametrize(
    "token",
    ["CI/lint", "and/or", "input/output"],
    ids=["ci-lint", "and-or", "input-output"],
)
def test_prose_slash_phrases_are_not_paths(token):
    """`A/B` prose shorthand is not a path claim.

    Regression: the Enforcement Index row "parsed by CI/lint configs" failed
    --require-enforcement-index because any slash token was treated as a path.
    """
    assert not crh.is_path_token(token)


@pytest.mark.parametrize(
    "token",
    ["scripts/test-guardrails.sh", ".github/workflows/ci.yml", "src/index.ts"],
    ids=["script", "workflow", "source"],
)
def test_real_paths_are_still_paths(token):
    """The prose exemption must not blind the checker to genuine paths."""
    assert crh.is_path_token(token)


CANONICAL_FIRST = """# AGENTS.md

## Code Canonicality

One implementation per concept.

## Project Identity

A service.
"""

CANONICAL_DEMOTED = """# AGENTS.md

## Project Identity

A service.

## Code Canonicality

One implementation per concept.
"""

CANONICAL_ABSENT = """# AGENTS.md

## Project Identity

A service.

## Commands

`just check`
"""


def test_canonicality_first_accepts_correct_order():
    """Clean input must pass, or the reject tests below prove nothing."""
    errors: list[str] = []
    crh.check_canonicality_first(CANONICAL_FIRST, errors)
    assert errors == []


def test_canonicality_first_rejects_demoted_section():
    """Field defect: a rendered AGENTS.md opened with ## Project Identity.

    Section order is fixed in every mode; an agent that reads the top of the
    file and stops must already know parallel _v1/_v2 files are banned.
    """
    errors: list[str] = []
    crh.check_canonicality_first(CANONICAL_DEMOTED, errors)
    assert errors, "demoted Code Canonicality must be rejected"
    assert "first section" in errors[0]
    assert "Project Identity" in errors[0]


def test_canonicality_first_ignores_absent_section():
    """Absence is not this check's job.

    In repair mode eng-init preserves a user-owned AGENTS.md; demanding its own
    section here would push an agent to reorder content it must not touch.
    Presence is required separately via --require-section.
    """
    errors: list[str] = []
    crh.check_canonicality_first(CANONICAL_ABSENT, errors)
    assert errors == []


def test_canonicality_first_ignores_files_with_no_sections():
    """A stub with no ## headings is a different failure, caught elsewhere."""
    errors: list[str] = []
    crh.check_canonicality_first("# AGENTS.md\n\nnothing yet\n", errors)
    assert errors == []


def test_agents_checks_run_without_the_ci_aggregator_flag(tmp_path, capsys, monkeypatch):
    """Regression: check_agents was nested under --require-ci-aggregator.

    A repo with no CI correctly omits that flag, and every AGENTS.md check —
    sections, Verification Matrix targets, Enforcement Index paths — silently
    no-opped. The checker printed PASS on an unvalidated file.
    """
    tmp_path.joinpath("AGENTS.md").write_text(CANONICAL_DEMOTED, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["check_rendered_harness.py", str(tmp_path)])
    rc = crh.main()
    captured = capsys.readouterr()
    out = captured.out + captured.err
    assert rc == 1, f"expected failure without the CI flag, got PASS:\n{out}"
    assert "first section" in out


def test_agents_checks_still_pass_a_valid_repo_without_the_ci_flag(tmp_path, capsys, monkeypatch):
    """The dedent must not turn the checker into a blanket rejecter."""
    tmp_path.joinpath("AGENTS.md").write_text(CANONICAL_FIRST, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["check_rendered_harness.py", str(tmp_path)])
    rc = crh.main()
    captured = capsys.readouterr()
    out = captured.out + captured.err
    assert rc == 0, f"valid repo must still pass:\n{out}"


# ---------------------------------------------------------------------------
# Audit gap (docs/2026-08-10-first-principles-audit.md): three checks had a real
# mechanism and zero proof it rejects anything. Independent review overturned
# their L3 rating for exactly the reason gate-quality-contract.md § Self-proof
# names — "a gate with a typo'd regex that matches nothing is green forever".
# Each is now pinned in both directions.
# ---------------------------------------------------------------------------

MATRIX_AGENTS = """# AGENTS.md

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


def seed_repo(tmp_path, agents: str, justfile: str = "test:\n\techo ok\n", lint=True):
    tmp_path.joinpath("AGENTS.md").write_text(agents, encoding="utf-8")
    tmp_path.joinpath("justfile").write_text(justfile, encoding="utf-8")
    if lint:
        tmp_path.joinpath("eslint.config.mjs").write_text("export default []\n", encoding="utf-8")
    return tmp_path


def run_checker(tmp_path, monkeypatch, capsys, *flags):
    monkeypatch.setattr(sys, "argv", ["check_rendered_harness.py", str(tmp_path), *flags])
    rc = crh.main()
    captured = capsys.readouterr()
    # Violations go to stderr per gate-quality-contract.md's protocol;
    # the success summary goes to stdout. Assertions care about content,
    # not stream, so both are returned.
    return rc, captured.out + captured.err


def test_matrix_target_resolution_accepts_a_real_target(tmp_path, monkeypatch, capsys):
    """Clean side: a Verification Matrix command that resolves to a real recipe."""
    seed_repo(tmp_path, MATRIX_AGENTS)
    rc, out = run_checker(tmp_path, monkeypatch, capsys)
    assert rc == 0, out


def test_matrix_target_resolution_rejects_a_ghost_target(tmp_path, monkeypatch, capsys):
    """The invariant this check exists for: a matrix row naming a nonexistent target."""
    seed_repo(tmp_path, MATRIX_AGENTS.replace("`just test`", "`just ghost-target`"))
    rc, out = run_checker(tmp_path, monkeypatch, capsys)
    assert rc == 1, out
    assert "ghost-target" in out and "no matching recipe target" in out


def test_enforcement_index_accepts_an_existing_config_path(tmp_path, monkeypatch, capsys):
    """Clean side, without which the rejection test below proves nothing."""
    seed_repo(tmp_path, MATRIX_AGENTS)
    rc, out = run_checker(tmp_path, monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 0, out


def test_enforcement_index_rejects_a_config_path_that_does_not_exist(tmp_path, monkeypatch, capsys):
    """A block-level row pointing at a file nobody wrote is phantom enforcement."""
    seed_repo(tmp_path, MATRIX_AGENTS.replace("`eslint.config.mjs`", "`config/never-written.mjs`"), lint=False)
    rc, out = run_checker(tmp_path, monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 1, out
    assert "never-written.mjs" in out


def test_enforcement_index_rejects_a_missing_section_when_required(tmp_path, monkeypatch, capsys):
    seed_repo(tmp_path, MATRIX_AGENTS.split("## Enforcement Index")[0])
    rc, out = run_checker(tmp_path, monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 1, out
    assert "Enforcement Index" in out


PROSE_TOOLS_AGENTS = """# AGENTS.md

## Code Canonicality

One implementation per concept.

## Verification Matrix

| Surface | Command |
|---|---|
| unit tests | `just test` |

## Enforcement Index

| Rule | Where it lives | Checked by | Level |
|---|---|---|---|
| no secrets committed | gitleaks | pre-commit | block |
| duplicate code | jscpd | CI | block |
| dead code | knip | CI | block |
"""


def test_enforcement_index_does_not_yet_catch_prose_tool_names(tmp_path, monkeypatch, capsys):
    """KNOWN COVERAGE GAP — pinned so it stays visible, not so it stays.

    Three block-level tools with no config file anywhere currently pass:
    `is_path_token` only sees path-shaped tokens (extension or slash), so a bare
    tool name is invisible, and the "Checked by" column matches the external-
    setting keyword regex (`CI`, `pre-commit`). The check therefore proves
    "every path-shaped config reference exists", which is narrower than the
    capability AGENTS.md advertises ("every named tool has a real config or is a
    declared external setting").

    Not fixed here on purpose: naming-based detection would need a tool registry
    or a heuristic, and a naive one produces false positives on real repos — the
    same failure mode as the ci-aggregator false positive fixed in iteration-53.

    If someone closes the gap, this test fails. That is the point: the change
    should be deliberate, and this docstring should be deleted with it.
    """
    seed_repo(tmp_path, PROSE_TOOLS_AGENTS, lint=False)
    rc, out = run_checker(tmp_path, monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 0, (
        "Coverage gap closed — good. Update this test to assert the rejection "
        f"and delete the known-gap docstring.\n{out}"
    )


# ---------------------------------------------------------------------------
# Mutation testing (2026-08-10) found two command->target resolution sites that
# no test exercised: neutering either left all 87 tests green. Both emit the same
# class of finding as the Verification Matrix site that WAS covered, which is how
# they stayed invisible — the message looked tested.
# ---------------------------------------------------------------------------

EI_COMMAND_AGENTS = """# AGENTS.md

## Code Canonicality

One implementation per concept.

## Verification Matrix

| Surface | Command |
|---|---|
| unit tests | `just test` |

## Enforcement Index

| Rule | Where it lives | Checked by | Level |
|---|---|---|---|
| lint clean | `eslint.config.mjs` | `just lint` | block |
"""


def test_enforcement_index_accepts_a_command_that_resolves(tmp_path, monkeypatch, capsys):
    seed_repo(tmp_path, EI_COMMAND_AGENTS, justfile="test:\n\techo ok\nlint:\n\techo ok\n")
    rc, out = run_checker(tmp_path, monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 0, out


def test_enforcement_index_rejects_a_command_with_no_target(tmp_path, monkeypatch, capsys):
    """A block-level row whose checker command does not exist is an unenforced rule."""
    seed_repo(tmp_path, EI_COMMAND_AGENTS, justfile="test:\n\techo ok\n")  # no `lint` recipe
    rc, out = run_checker(tmp_path, monkeypatch, capsys, "--require-enforcement-index")
    assert rc == 1, out
    assert "Enforcement Index command `just lint`" in out and "no matching recipe target" in out


CONSTRAINTS_MIRROR = """verification:
  surfaces:
    - name: unit tests
      command: "just test"
"""


def test_constraints_verification_accepts_a_mirrored_command_that_resolves(tmp_path, monkeypatch, capsys):
    seed_repo(tmp_path, MATRIX_AGENTS)
    tmp_path.joinpath("constraints.yaml").write_text(CONSTRAINTS_MIRROR, encoding="utf-8")
    rc, out = run_checker(tmp_path, monkeypatch, capsys)
    assert rc == 0, out


def test_constraints_command_with_no_target_is_reported_by_the_matrix_check(tmp_path, monkeypatch, capsys):
    """Pins a shadowed branch rather than pretending to test it.

    check_rendered_harness.py has a `constraints.yaml verification command ... has
    no matching recipe target` failure, but it can never be the sole cause: a
    constraints command is either in the Verification Matrix (the matrix check at
    the loop above flags the missing target first) or absent from it (the
    not-present check flags that instead). Mutation testing exposed this — the
    branch survived being neutered because nothing can reach it alone.

    An earlier version of this test asserted only that "just smoke" and "no
    matching recipe target" appeared in the output, which passed for the wrong
    reason: the matrix check produced them. Asserting the actual owner keeps the
    redundancy visible; if the branch ever becomes reachable, this test fails and
    someone must decide whether it earns its own assertion or should be deleted.
    """
    agents = MATRIX_AGENTS.replace("| unit tests | `just test` |",
                                   "| unit tests | `just test` |\n| smoke | `just smoke` |")
    seed_repo(tmp_path, agents)
    tmp_path.joinpath("constraints.yaml").write_text(
        CONSTRAINTS_MIRROR + '    - name: smoke\n      command: "just smoke"\n', encoding="utf-8")
    rc, out = run_checker(tmp_path, monkeypatch, capsys)
    assert rc == 1, out
    assert "Verification Matrix command `just smoke` has no matching recipe target" in out
    assert "constraints.yaml verification command `just smoke` has no matching recipe target" in out, (
        "the constraints branch fires too, but only alongside the matrix one — "
        "it is redundant, never the sole cause"
    )
