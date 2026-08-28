"""Dual-assertion tests for the two readiness validators.

Audit finding (docs/2026-08-10-first-principles-audit.md): `score_readiness_report.py`
and `validate_readiness_repair.py` were named in SKILL.md's reference index as the
Audit and Repair pipeline validators, had zero tests, and were not executed by
`selfcheck.sh`. A program nothing ever runs and nothing proves can reject is the
phantom enforcement this skill exists to prevent — so each rule below is pinned in
both directions: a valid payload passes first, then one mutation per rule is
rejected with its message asserted.
"""

import importlib.util
import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2]
REGISTRY = SKILL / "references" / "readiness-registry.yaml"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, SKILL / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


score_mod = _load("score_readiness_report")
repair_mod = _load("validate_readiness_repair")
REGISTRY_DATA = score_mod.parse_registry(REGISTRY)


# --------------------------------------------------------------------------
# score_readiness_report.py
# --------------------------------------------------------------------------

def valid_report() -> dict:
    """One repository-scope row and one application-scope row over two apps.

    agents_md is repository scope (denominator 1); strict_typing is application
    scope (denominator = app count) and skippable, exercising the null-numerator
    branch. Scope is read from the registry, not assumed — an earlier draft of
    this fixture used a repository-scope criterion as the application-scope row
    and the acceptance assertion caught it.
    """
    return {
        "applications": [{"name": "api"}, {"name": "web"}],
        "score": {"applications_identified": 2, "average": 1.0},
        "criteria": [
            {
                "id": "agents_md",
                "denominator": 1,
                "numerator": 1,
                "status": "passing",
                "evidence": "AGENTS.md exists with commands",
                "validator": "file exists and is non-trivial",
                "rescore_rule": "1/1 when present",
            },
            {
                "id": "strict_typing",
                "denominator": 2,
                "numerator": None,
                "status": "skipped",
                "evidence": "neither app is typed; no type checker applicable yet",
                "validator": "type checker configured and blocking",
                "rescore_rule": "null when the stack has no type system",
            },
        ],
        "configured_but_not_blocking": [],
    }


def test_score_accepts_a_valid_report():
    """Clean input passes, or every rejection below proves nothing."""
    computed, errors = score_mod.score(valid_report(), REGISTRY_DATA)
    assert errors == [], errors
    assert computed == pytest.approx(1.0)


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda r: r["criteria"][0].update(id="not_a_real_criterion"), "unknown id"),
        (lambda r: r["criteria"][0].update(denominator=2), "must be 1"),
        (lambda r: r["criteria"][1].update(denominator=1), "must be 2"),
        (lambda r: r["criteria"][0].update(numerator=5), "out of range"),
        (lambda r: r["criteria"][0].update(evidence=""), "evidence is required"),
        (lambda r: r["criteria"][0].update(validator=""), "validator is required"),
        (lambda r: r["criteria"][0].update(rescore_rule=""), "rescore_rule is required"),
        (lambda r: r["score"].update(average=0.42), "does not match computed"),
        (lambda r: r["score"].update(applications_identified=7), "applications_identified"),
        (lambda r: r.update(applications=[]), "non-empty list"),
    ],
    ids=[
        "unknown-criterion", "repo-scope-denominator", "app-scope-denominator",
        "numerator-out-of-range", "missing-evidence", "missing-validator",
        "missing-rescore-rule", "average-mismatch", "app-count-mismatch",
        "empty-applications",
    ],
)
def test_score_rejects_each_violation(mutate, expected):
    report = valid_report()
    mutate(report)
    _, errors = score_mod.score(report, REGISTRY_DATA)
    assert errors, f"expected rejection for {expected!r}"
    assert any(expected in e for e in errors), f"{expected!r} not in {errors}"


def test_score_rejects_null_numerator_on_a_non_skippable_criterion():
    """A null numerator is only legal when the registry marks the criterion skippable.

    Without this, any failing criterion could be laundered into "not applicable".
    """
    report = valid_report()
    report["criteria"][0].update(numerator=None, status="skipped")
    _, errors = score_mod.score(report, REGISTRY_DATA)
    assert any("null numerator requires skippable" in e for e in errors), errors


def test_score_rejects_configured_but_not_blocking_row_claiming_full_pass():
    """Half credit must be recorded as partial, not passing."""
    report = valid_report()
    report["configured_but_not_blocking"] = ["agents_md"]
    _, errors = score_mod.score(report, REGISTRY_DATA)
    assert any("must be partial" in e for e in errors), errors


def test_score_cli_exits_zero_then_nonzero(tmp_path, monkeypatch, capsys):
    """The CLI wrapper, not just the scoring function, must carry the exit code."""
    good = tmp_path / "good.json"
    good.write_text(json.dumps(valid_report()), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["x", str(good), "--registry", str(REGISTRY)])
    assert score_mod.main(sys.argv) == 0
    assert "score:" in capsys.readouterr().out

    bad_report = valid_report()
    bad_report["score"]["average"] = 0.1
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(bad_report), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["x", str(bad), "--registry", str(REGISTRY)])
    assert score_mod.main(sys.argv) == 1
    err = capsys.readouterr().err
    assert "score-readiness-report:" in err and "violation(s) found" in err, err


# --------------------------------------------------------------------------
# validate_readiness_repair.py
# --------------------------------------------------------------------------

def valid_handoff() -> dict:
    """A class-A (skill-owned) repair reported as repaired with a green validator."""
    return {
        "schema_version": 1,
        "requested_signal": "fix the guardrail self-test",
        "matched_criterion": "guardrail_self_test",
        "fixability": "A",
        "pre_state": {"status": "failing", "evidence": "scripts/test-guardrails.sh absent"},
        "allowed_files": ["scripts/test-guardrails.sh", ".github/workflows/agents-md-liveness.yml"],
        "validator": {
            "command": "bash scripts/test-guardrails.sh",
            "exit_code": 0,
            "evidence": "3 passed, 0 failed",
        },
        "post_state": {
            "status": "passing",
            "rescore_evidence": "guardrail_self_test=1/1",
        },
        "decision": "repaired",
    }


def test_repair_accepts_a_valid_handoff():
    """Clean input passes first."""
    assert repair_mod.validate(valid_handoff(), REGISTRY_DATA) == []


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda h: h.pop("requested_signal"), "missing required field"),
        (lambda h: h.update(matched_criterion="invented_criterion"), "not in readiness registry"),
        (lambda h: h.update(decision="looks_fine_to_me"), "invalid decision"),
        (lambda h: h.update(fixability="D"), "must match registry"),
        (lambda h: h["validator"].update(command=""), "validator.command is required"),
        (lambda h: h["validator"].pop("exit_code"), "validator.exit_code is required"),
        (lambda h: h["validator"].update(evidence=""), "validator.evidence is required"),
        (lambda h: h["pre_state"].update(evidence=""), "pre_state.evidence is required"),
        (lambda h: h["post_state"].update(rescore_evidence=""), "rescore_evidence is required"),
        (lambda h: h.update(allowed_files="scripts/x.sh"), "allowed_files must be a list"),
        (lambda h: h["validator"].update(exit_code=1), "requires validator.exit_code=0"),
    ],
    ids=[
        "missing-field", "unknown-criterion", "invalid-decision", "fixability-mismatch",
        "no-validator-command", "no-exit-code", "no-validator-evidence",
        "no-pre-evidence", "no-rescore-evidence", "allowed-files-not-list",
        "repaired-with-red-validator",
    ],
)
def test_repair_rejects_each_violation(mutate, expected):
    handoff = valid_handoff()
    mutate(handoff)
    errors = repair_mod.validate(handoff, REGISTRY_DATA)
    assert errors, f"expected rejection for {expected!r}"
    assert any(expected in e for e in errors), f"{expected!r} not in {errors}"


def test_repair_rejects_fake_local_completion_of_an_external_criterion():
    """The anti-gaming rule this validator exists for.

    A class-D external/governance control (branch protection is set server-side)
    cannot be completed by editing local files. Claiming `repaired` without
    authenticated external evidence must be rejected, or the loop can mark
    governance work done by writing a file.
    """
    external = [cid for cid, m in REGISTRY_DATA.items() if m.get("fixability") == "D"]
    assert external, "registry must contain at least one class-D criterion for this test to mean anything"
    handoff = valid_handoff()
    handoff.update(matched_criterion=external[0], fixability="D")
    errors = repair_mod.validate(handoff, REGISTRY_DATA)
    assert any("fake local completion" in e for e in errors), errors

    # The escape hatch must work: authenticated external evidence is accepted.
    ok = deepcopy(handoff)
    ok["validator"]["evidence"] = "authenticated gh api call shows the ruleset enabled"
    assert not [e for e in repair_mod.validate(ok, REGISTRY_DATA) if "fake local completion" in e]


def test_repair_rejects_metric_gaming_prone_repair_without_evidence():
    """unit_tests_exist / lint_config / test_coverage_thresholds are the criteria a
    loop can satisfy with empty tests or a disabled config, so a repaired handoff
    must record what gaming it rejected."""
    handoff = valid_handoff()
    handoff.update(matched_criterion="unit_tests_exist",
                   fixability=REGISTRY_DATA["unit_tests_exist"]["fixability"])
    errors = repair_mod.validate(handoff, REGISTRY_DATA)
    assert any("metric_gaming_rejected" in e for e in errors), errors

    handoff["metric_gaming_rejected"] = ["no assertion-free placeholder tests were added"]
    assert not [e for e in repair_mod.validate(handoff, REGISTRY_DATA) if "metric_gaming_rejected" in e]


def test_repair_rejects_blocked_decision_claiming_a_passing_post_state():
    handoff = valid_handoff()
    handoff.update(decision="pending_external")
    errors = repair_mod.validate(handoff, REGISTRY_DATA)
    assert any("cannot produce a passing post_state" in e for e in errors), errors


def test_repair_cli_exits_zero_then_nonzero(tmp_path, monkeypatch, capsys):
    good = tmp_path / "good.json"
    good.write_text(json.dumps(valid_handoff()), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["x", str(good), "--registry", str(REGISTRY)])
    assert repair_mod.main(sys.argv) == 0
    assert "conforms" in capsys.readouterr().out

    bad_handoff = valid_handoff()
    bad_handoff["decision"] = "nonsense"
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(bad_handoff), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["x", str(bad), "--registry", str(REGISTRY)])
    assert repair_mod.main(sys.argv) == 1
    err = capsys.readouterr().err
    assert "validate-readiness-repair:" in err and "violation(s) found" in err, err
