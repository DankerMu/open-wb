from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("vdd_lint", ROOT / "tools" / "vdd_lint.py")
assert SPEC and SPEC.loader
vdd_lint = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = vdd_lint
SPEC.loader.exec_module(vdd_lint)


def load(relative: str):
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


class ContractLintTests(unittest.TestCase):
    def test_reference_contracts_pass(self):
        for path in [
            "examples/light-construction/contract.json",
            "examples/standard-equivalence/contract.json",
        ]:
            with self.subTest(path=path):
                result = vdd_lint.validate_contract(load(path))
                self.assertEqual([], result.errors, result.errors)

    def test_contract_fingerprint_includes_nested_asset_identities(self):
        contract = load("examples/light-construction/contract.json")
        original = vdd_lint.contract_fingerprint(contract)
        contract["fixtures"][0]["fingerprint"] = "sha256:" + "0" * 64
        self.assertNotEqual(original, vdd_lint.contract_fingerprint(contract))

    def test_equivalence_requires_reference_green(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["baseline"]["reference_green_command"] = None
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(any("reference_green_command" in error for error in result.errors))

    def test_stability_commands_cannot_overlap_control_plane_roles(self):
        contract = load("examples/light-construction/contract.json")
        contract["control_plane"] = {
            "discovery": {"command_id": "DISCOVERY"}
        }
        contract["oracles"][0]["qualification"]["stability_command_ids"] = [
            "DISCOVERY"
        ]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any(
                "overlap non-stability control-plane roles" in error
                for error in result.errors
            ),
            result.errors,
        )

    def test_standard_candidate_cannot_own_acceptance(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["roles"]["acceptor"] = contract["roles"]["implementer"]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(any("acceptor must be independent" in error for error in result.errors))

    def test_candidate_writable_subpath_can_narrow_editable_scope(self):
        contract = load("examples/light-construction/contract.json")
        contract["scope"]["editable"] = ["src"]
        contract["candidate_capabilities"]["writable_paths"] = ["src/slug.py"]
        result = vdd_lint.validate_contract(contract)
        self.assertFalse(
            any("writable paths exceed" in error for error in result.errors),
            result.errors,
        )

    def test_candidate_writable_path_cannot_escape_editable_scope(self):
        contract = load("examples/light-construction/contract.json")
        contract["scope"]["editable"] = ["src"]
        contract["candidate_capabilities"]["writable_paths"] = ["src/../verifier.py"]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(any("writable paths exceed" in error for error in result.errors))

    def test_high_claim_requires_defeater(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["claims"][0]["defeater_ids"] = []
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(any("requires at least one defeater" in error for error in result.errors))

    def test_covered_defeater_requires_known_bad_qualification(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["oracles"][0]["qualification"]["known_bad_cases"] = []
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(any("known_bad_case" in error for error in result.errors))
        self.assertTrue(any("not exercised" in error for error in result.errors))

    def test_fresh_qualification_requires_known_bad_case(self):
        contract = load("examples/light-construction/contract.json")
        contract["defeaters"][0]["status"] = "unknown"
        contract["defeaters"][0]["oracle_ids"] = []
        contract["claims"][0]["defeater_ids"] = []
        contract["oracles"][0]["qualification"]["known_bad_cases"] = []
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("known_bad_cases" in error and "at least one" in error for error in result.errors),
            result.errors,
        )

    def test_standard_requires_integration_gate_not_only_broad(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["gates"]["integration"] = None
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("requires an integration gate" in error for error in result.errors),
            result.errors,
        )

    def test_real_upstream_workflow_requires_distinct_pinned_gate_bindings(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["source_provenance"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "require_clean": True,
        }
        actual_platform = vdd_lint.runtime_platform_identity()["platform_id"]
        contract["gates"]["focused"] = "focused upstream"
        contract["gates"]["broad"] = "broad upstream"
        contract["control_plane"] = {
            "candidate_artifacts": ["candidate.py"],
            "protected_assets": [
                {"path": "tests/focused.py", "fingerprint": "sha256:" + "1" * 64},
                {"path": "tests/broad.py", "fingerprint": "sha256:" + "2" * 64},
            ],
            "allowed_output_paths": [],
            "environment_allowlist": [],
            "discovery": {"command_id": "DISCOVERY", "result_path": "out.json", "producer_path": "tests/focused.py"},
            "execution_plan": [
                {"id": "UPSTREAM-FOCUSED", "display": "focused upstream", "argv": ["python", "-m", "pytest", "tests/focused.py"], "expected_exit_code": 0, "result": "pass", "write_paths": [], "artifact_refs": ["tests/focused.py"]},
                {"id": "UPSTREAM-BROAD", "display": "broad upstream", "argv": ["python", "-m", "pytest", "tests/focused.py", "tests/broad.py"], "expected_exit_code": 0, "result": "pass", "write_paths": [], "artifact_refs": ["tests/focused.py", "tests/broad.py"]},
            ],
        }
        contract["real_upstream_workflow"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "focused_command_id": "UPSTREAM-FOCUSED",
            "broad_command_id": "UPSTREAM-BROAD",
            "focused_artifacts": ["tests/focused.py"],
            "broad_artifacts": ["tests/focused.py", "tests/broad.py"],
            "platform": actual_platform,
        }
        self.assertEqual([], vdd_lint.validate_contract(contract).errors)
        contract["real_upstream_workflow"]["platform"] = "other-platform"
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("platform must equal" in error for error in result.errors),
            result.errors,
        )
        contract["real_upstream_workflow"]["platform"] = actual_platform
        contract["control_plane"]["execution_plan"][0]["argv"] = [
            "python", "-m", "pytest", "--version"
        ]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("focused step argv must list" in error for error in result.errors),
            result.errors,
        )
        contract["control_plane"]["execution_plan"][0]["argv"] = [
            "python", "-m", "pytest", "tests/focused.py"
        ]
        contract["real_upstream_workflow"]["broad_artifacts"] = ["tests/focused.py"]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("strictly extend focused_artifacts" in error for error in result.errors),
            result.errors,
        )
        contract["real_upstream_workflow"]["broad_artifacts"] = [
            "tests/focused.py", "tests/broad.py"
        ]
        contract["real_upstream_workflow"]["broad_command_id"] = "UPSTREAM-FOCUSED"
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("focused_command_id and broad_command_id must be distinct" in error for error in result.errors),
            result.errors,
        )

    def test_real_upstream_workflow_requires_immutable_source_provenance(self):
        contract = load("examples/standard-equivalence/contract.json")
        actual_platform = vdd_lint.runtime_platform_identity()["platform_id"]
        contract["gates"]["focused"] = "focused upstream"
        contract["gates"]["broad"] = "broad upstream"
        contract["control_plane"] = {
            "candidate_artifacts": ["candidate.py"],
            "protected_assets": [
                {"path": "tests/focused.py", "fingerprint": "sha256:" + "1" * 64},
                {"path": "tests/broad.py", "fingerprint": "sha256:" + "2" * 64},
            ],
            "allowed_output_paths": [],
            "environment_allowlist": [],
            "discovery": {"command_id": "DISCOVERY", "result_path": "out.json", "producer_path": "tests/focused.py"},
            "execution_plan": [
                {"id": "UPSTREAM-FOCUSED", "display": "focused upstream", "argv": ["python", "-m", "pytest", "tests/focused.py"], "expected_exit_code": 0, "result": "pass", "write_paths": [], "artifact_refs": ["tests/focused.py"]},
                {"id": "UPSTREAM-BROAD", "display": "broad upstream", "argv": ["python", "-m", "pytest", "tests/focused.py", "tests/broad.py"], "expected_exit_code": 0, "result": "pass", "write_paths": [], "artifact_refs": ["tests/focused.py", "tests/broad.py"]},
            ],
        }
        contract["real_upstream_workflow"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "focused_command_id": "UPSTREAM-FOCUSED",
            "broad_command_id": "UPSTREAM-BROAD",
            "focused_artifacts": ["tests/focused.py"],
            "broad_artifacts": ["tests/focused.py", "tests/broad.py"],
            "platform": actual_platform,
        }
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("real upstream workflow requires source_provenance" in error for error in result.errors),
            result.errors,
        )
        contract["source_provenance"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "main",
            "require_clean": True,
        }
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("immutable revision" in error for error in result.errors),
            result.errors,
        )

    def test_improvement_requires_contract_hard_constraint_commands(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["mode"] = "improvement"
        contract["oracles"][0]["type"] = "benchmark"
        contract["baseline"] = {
            "semantic_red_command": None,
            "reference_green_command": None,
            "semantic_green_command": "python verifier/diff_cli.py --candidate target/debug/replacement-cli",
            "hard_constraint_commands": [],
            "metric": {
                "name": "latency",
                "direction": "lower",
                "baseline_command": "./verifier/run_packaged_cli.sh candidate",
                "runs": 5,
                "noise_band": "5%",
                "minimum_improvement": "10%",
            },
        }
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("hard_constraint_commands" in error for error in result.errors),
            result.errors,
        )

    def test_claim_cannot_reference_another_claims_defeater(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["claims"][0]["defeater_ids"] = ["D-LEGACY-DELEGATION"]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(any("belongs to claim" in error for error in result.errors))
    def test_oracle_claim_links_must_be_reciprocal(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["oracles"][0]["claims"] = ["NONEXISTENT-CLAIM"]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(any("oracle O-CLI-DIFF references unknown claim" in error for error in result.errors))
        self.assertTrue(any("does not link back" in error for error in result.errors))
    def test_reused_deterministic_oracle_does_not_require_new_mutants_or_trials(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["claims"][1]["oracle_ids"].append("O-STATIC")
        contract["oracles"].append(
            {
                "id": "O-STATIC",
                "type": "static",
                "owner": "cli-verifier",
                "protected": True,
                "revision": "static@7",
                "fingerprint": "sha256:static",
                "claims": ["C-CLI-CUTOVER"],
                "failure_classes": [],
                "quality": {
                    "fidelity": "medium",
                    "independence": "high",
                    "sensitivity": "low",
                    "reproducibility": "high",
                    "environment_realism": "low",
                },
                "qualification": {
                    "status": "reused",
                    "prior_attestation_id": "A-STATIC-007",
                    "prior_attestation_digest": "sha256:prior-static",
                    "qualified_fingerprint": "sha256:static",
                    "qualification_contract_fingerprint": "sha256:" + "a" * 64,
                    "qualification_basis": {"source": "static@7"},
                    "covered_defeater_ids": [],
                    "known_good_command": None,
                    "known_bad_cases": [],
                    "restore_command": None,
                    "stability_required": False,
                    "required_no_change_trials": 0,
                    "max_flake_rate": 0.0,
                },
            }
        )
        result = vdd_lint.validate_contract(contract)
        self.assertFalse(any("O-STATIC" in error for error in result.errors), result.errors)

    def test_spec_dispute_is_a_characterization_only_intent_state(self):
        contract = load("examples/light-construction/contract.json")
        contract["intent"]["status"] = "spec_dispute"
        construction = vdd_lint.validate_contract(contract)
        self.assertTrue(any("requires validated intent" in error for error in construction.errors))
        self.assertFalse(any("status must be" in error for error in construction.errors))

        contract["mode"] = "characterization"
        contract["baseline"]["semantic_green_command"] = "python -m unittest tests.test_slugify"
        characterization = vdd_lint.validate_contract(contract)
        self.assertFalse(any("status must be" in error for error in characterization.errors))

    def test_accepted_characterization_requires_validated_intent(self):
        contract = load("examples/light-construction/contract.json")
        contract["mode"] = "characterization"
        contract["intent"]["status"] = "spec_dispute"
        contract["baseline"]["semantic_green_command"] = "python -m unittest tests.test_slugify"

        evidence = load("examples/light-construction/evidence.json")
        evidence["mode"] = "characterization"
        evidence["stage"] = "characterization"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["mode_evidence"] = {
            "known_good_commands": ["FOCUSED"],
            "known_bad_commands": ["BASE-RED"],
            "stability_trials": 1,
            "unknowns": [],
            "reusable_artifacts": ["semantic-baseline"],
        }
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("accepted characterization requires validated intent" in error for error in result.errors))

    def test_critical_contract_requires_nonempty_environment_matrix(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["risk_profile"] = "critical"
        contract["roles"]["release_owner"] = "cli-release-owner"
        contract["gates"]["release"] = "python verifier/release_gate.py"
        contract["environment"]["matrix"] = []
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any(
                "environment.matrix must declare supported platforms" in error
                for error in result.errors
            ),
            result.errors,
        )

    def test_critical_platform_results_reject_reused_command_ids(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["risk_profile"] = "critical"
        contract["roles"]["release_owner"] = "cli-release-owner"
        contract["gates"]["release"] = "python verifier/release_gate.py"
        contract["environment"]["matrix"] = ["linux-x86_64", "macos-arm64"]
        contract["control_plane"] = {
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "platform_results": {
                "linux-x86_64": {
                    "command_id": "PLATFORM-SHARED",
                    "result_path": "artifacts/linux.json",
                    "producer_path": "verifier/platform_linux.py",
                },
                "macos-arm64": {
                    "command_id": "PLATFORM-SHARED",
                    "result_path": "artifacts/macos.json",
                    "producer_path": "verifier/platform_macos.py",
                },
            },
        }
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any(
                "platform_results" in error
                and "unique" in error
                and "command_id" in error
                for error in result.errors
            ),
            result.errors,
        )

    def test_enabled_runtime_feedback_requires_signals_and_corpus(self):
        contract = load("examples/light-construction/contract.json")
        contract["runtime_feedback"] = {
            "enabled": True,
            "signals": [],
            "permanent_corpus_path": None,
        }
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any(
                "enabled runtime feedback requires signals" in error
                for error in result.errors
            ),
            result.errors,
        )
        self.assertTrue(
            any(
                "enabled runtime feedback requires permanent_corpus_path" in error
                for error in result.errors
            ),
            result.errors,
        )






class EvidenceLintTests(unittest.TestCase):
    def setUp(self):
        self.contract = load("examples/standard-equivalence/contract.json")
        self.evidence = load("examples/standard-equivalence/evidence.json")

    def test_reference_evidence_passes(self):
        result = vdd_lint.validate_evidence(self.evidence, self.contract)
        self.assertEqual([], result.errors, result.errors)
    def test_accepted_evidence_requires_linked_contract(self):
        result = vdd_lint.validate_evidence(self.evidence)
        self.assertTrue(any("linked contract" in error for error in result.errors))
    def test_source_provenance_requires_exact_candidate_artifact_bindings(self):
        contract = copy.deepcopy(self.contract)
        contract["source_provenance"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "require_clean": True,
        }
        contract["control_plane"] = {"candidate_artifacts": ["candidate.py"]}
        evidence = copy.deepcopy(self.evidence)
        evidence["control_plane"] = {
            "source_provenance": {
                "repository": "https://example.invalid/upstream.git",
                "revision": "a" * 40,
                "clean": True,
                "candidate_artifacts": [
                    {
                        "path": "unexpected.py",
                        "fingerprint": "sha256:" + "1" * 64,
                        "source_fingerprint": "sha256:" + "1" * 64,
                        "git_type": "file",
                        "git_mode": "100644",
                        "git_object": "a" * 40,
                    }
                ],
            }
        }
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("candidate artifact paths differ" in error for error in result.errors),
            result.errors,
        )

    def test_source_provenance_requires_candidate_snapshot_fingerprint_binding(self):
        contract = copy.deepcopy(self.contract)
        contract["source_provenance"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "require_clean": True,
        }
        contract["control_plane"] = {"candidate_artifacts": ["candidate.py"]}
        evidence = copy.deepcopy(self.evidence)
        evidence["control_plane"] = {
            "candidate_snapshot_before": [
                {"path": "candidate.py", "fingerprint": "sha256:" + "2" * 64}
            ],
            "source_provenance": {
                "repository": "https://example.invalid/upstream.git",
                "revision": "a" * 40,
                "clean": True,
                "candidate_artifacts": [
                    {
                        "path": "candidate.py",
                        "fingerprint": "sha256:" + "1" * 64,
                        "source_fingerprint": "sha256:" + "1" * 64,
                        "git_type": "file",
                        "git_mode": "100644",
                        "git_object": "a" * 40,
                    }
                ],
            },
        }
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("fingerprints differ from candidate snapshot" in error for error in result.errors),
            result.errors,
        )

    def test_real_upstream_evidence_requires_exact_git_tree_bindings(self):
        contract = copy.deepcopy(self.contract)
        contract["source_provenance"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "require_clean": True,
        }
        actual_platform = vdd_lint.runtime_platform_identity()["platform_id"]
        contract["gates"]["focused"] = "focused upstream"
        contract["gates"]["broad"] = "broad upstream"
        contract["gates"]["integration"] = "broad upstream"
        contract["control_plane"] = {
            "candidate_artifacts": ["candidate.py"],
            "protected_assets": [
                {"path": "tests/focused.py", "fingerprint": "sha256:" + "2" * 64},
                {"path": "tests/broad.py", "fingerprint": "sha256:" + "3" * 64},
            ],
            "execution_plan": [
                {
                    "id": "DIFF",
                    "display": "focused upstream",
                    "argv": ["python", "-m", "pytest", "tests/focused.py"],
                    "artifact_refs": ["tests/focused.py"],
                },
                {
                    "id": "INTEGRATION",
                    "display": "broad upstream",
                    "argv": [
                        "python",
                        "-m",
                        "pytest",
                        "tests/focused.py",
                        "tests/broad.py",
                    ],
                    "artifact_refs": ["tests/focused.py", "tests/broad.py"],
                },
            ],
        }
        contract["real_upstream_workflow"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "focused_command_id": "DIFF",
            "broad_command_id": "INTEGRATION",
            "focused_artifacts": ["tests/focused.py"],
            "broad_artifacts": ["tests/focused.py", "tests/broad.py"],
            "platform": actual_platform,
        }
        evidence = copy.deepcopy(self.evidence)
        for command in evidence["commands"]:
            if command["id"] == "DIFF":
                command["command"] = "focused upstream"
                command["artifact_refs"] = ["tests/focused.py"]
            elif command["id"] == "INTEGRATION":
                command["command"] = "broad upstream"
                command["artifact_refs"] = ["tests/focused.py", "tests/broad.py"]
        evidence["control_plane"] = {"source_provenance": {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "clean": True,
            "candidate_artifacts": [
                {
                    "path": "candidate.py",
                    "fingerprint": "sha256:" + "1" * 64,
                    "source_fingerprint": "sha256:" + "1" * 64,
                    "git_type": "file",
                    "git_mode": "100644",
                    "git_object": "a" * 40,
                }
            ],
        }}
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("real upstream artifact bindings" in error for error in result.errors),
            result.errors,
        )

    def test_real_upstream_evidence_requires_protected_fingerprint_binding(self):
        contract = copy.deepcopy(self.contract)
        actual_platform = vdd_lint.runtime_platform_identity()["platform_id"]
        contract["source_provenance"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "require_clean": True,
        }
        contract["gates"]["focused"] = "focused upstream"
        contract["gates"]["broad"] = "broad upstream"
        contract["gates"]["integration"] = "broad upstream"
        contract["control_plane"] = {
            "candidate_artifacts": ["candidate.py"],
            "protected_assets": [
                {"path": "tests/focused.py", "fingerprint": "sha256:" + "2" * 64},
                {"path": "tests/broad.py", "fingerprint": "sha256:" + "3" * 64},
            ],
            "execution_plan": [
                {
                    "id": "DIFF",
                    "display": "focused upstream",
                    "argv": ["python", "-m", "pytest", "tests/focused.py"],
                    "artifact_refs": ["tests/focused.py"],
                },
                {
                    "id": "INTEGRATION",
                    "display": "broad upstream",
                    "argv": [
                        "python",
                        "-m",
                        "pytest",
                        "tests/focused.py",
                        "tests/broad.py",
                    ],
                    "artifact_refs": ["tests/focused.py", "tests/broad.py"],
                },
            ],
        }
        contract["real_upstream_workflow"] = {
            "repository": "https://example.invalid/upstream.git",
            "revision": "a" * 40,
            "focused_command_id": "DIFF",
            "broad_command_id": "INTEGRATION",
            "focused_artifacts": ["tests/focused.py"],
            "broad_artifacts": ["tests/focused.py", "tests/broad.py"],
            "platform": actual_platform,
        }
        evidence = copy.deepcopy(self.evidence)
        for command in evidence["commands"]:
            if command["id"] == "DIFF":
                command["command"] = "focused upstream"
                command["artifact_refs"] = ["tests/focused.py"]
            elif command["id"] == "INTEGRATION":
                command["command"] = "broad upstream"
                command["artifact_refs"] = ["tests/focused.py", "tests/broad.py"]
        evidence["control_plane"] = {
            "source_provenance": {
                "repository": "https://example.invalid/upstream.git",
                "revision": "a" * 40,
                "clean": True,
                "candidate_artifacts": [
                    {
                        "path": "candidate.py",
                        "fingerprint": "sha256:" + "1" * 64,
                        "source_fingerprint": "sha256:" + "1" * 64,
                        "git_type": "file",
                        "git_mode": "100644",
                        "git_object": "a" * 40,
                    }
                ],
                "real_upstream_artifacts": [
                    {
                        "path": "tests/focused.py",
                        "fingerprint": "sha256:" + "9" * 64,
                        "git_type": "file",
                        "git_mode": "100644",
                        "git_object": "b" * 40,
                    },
                    {
                        "path": "tests/broad.py",
                        "fingerprint": "sha256:" + "3" * 64,
                        "git_type": "file",
                        "git_mode": "100644",
                        "git_object": "c" * 40,
                    },
                ],
            }
        }
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("fingerprints differ from protected assets" in error for error in result.errors),
            result.errors,
        )

    def test_output_capture_rejects_noncanonical_or_oversized_metadata(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["control_plane"] = {"output_directory": "/control-plane/retained"}
        capture = {
            "stdout": {
                "path": "../stdout.bin",
                "byte_length": 8 * 1024 * 1024 + 1,
                "digest": "sha256:" + "0" * 64,
                "fingerprint": "sha256:" + "0" * 64,
            },
            "stderr": {
                "path": "commands/test/stderr.bin",
                "byte_length": 0,
                "digest": "sha256:" + "0" * 64,
                "fingerprint": "sha256:" + "0" * 64,
            },
            "isolation": {
                "path": "commands/test/isolation.bin",
                "fingerprint": "sha256:" + "0" * 64,
                "provider": "test",
                "policy_format": "test",
                "executable_fingerprint": "sha256:" + "0" * 64,
            },
        }
        for command in evidence["commands"]:
            command["output_capture"] = copy.deepcopy(capture)
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(
            any("path must be canonical" in error for error in result.errors),
            result.errors,
        )
        self.assertTrue(
            any("byte_length must not exceed" in error for error in result.errors),
            result.errors,
        )
        self.assertTrue(
            any("duplicate retained output path" in error for error in result.errors),
            result.errors,
        )

    def test_output_capture_requires_control_plane_output_directory(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["commands"][0]["output_capture"] = {
            "stdout": {"path": "commands/test/stdout.bin", "byte_length": 0, "digest": "sha256:" + "0" * 64, "fingerprint": "sha256:" + "0" * 64},
            "stderr": {"path": "commands/test/stderr.bin", "byte_length": 0, "digest": "sha256:" + "0" * 64, "fingerprint": "sha256:" + "0" * 64},
            "isolation": {"path": "commands/test/isolation.bin", "fingerprint": "sha256:" + "0" * 64, "provider": "test", "policy_format": "test", "executable_fingerprint": "sha256:" + "0" * 64},
        }
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(
            any("output_capture requires control_plane.output_directory" in error for error in result.errors),
            result.errors,
        )

    def test_command_result_must_match_exit_code(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["commands"][0]["exit_code"] = 1
        evidence["commands"][0]["result"] = "pass"
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("pass requires exit_code 0" in error for error in result.errors))
    def test_confirmed_claim_requires_command_evidence(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["claim_results"][0]["evidence_refs"] = []
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("requires command evidence_refs" in error for error in result.errors))

    def test_claim_and_defeater_refs_require_declared_semantic_coverage(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["claim_results"][0]["evidence_refs"] = ["QUAL-EXIT"]
        evidence["defeater_results"][0]["evidence_refs"] = ["BROAD"]
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("does not declare claim C-CLI-OUTPUT coverage" in error for error in result.errors))
        self.assertTrue(any("does not declare defeater D-EXIT-CODE coverage" in error for error in result.errors))
        self.assertTrue(any("requires rejection and candidate-pass evidence" in error for error in result.errors))
    def test_mode_baseline_command_must_be_executed(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["commands"] = [
            command for command in evidence["commands"] if command["id"] != "REF-GREEN"
        ]
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("reference GREEN command was not executed" in error for error in result.errors))
    def test_required_focused_gate_must_be_executed(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["commands"] = [
            command for command in evidence["commands"] if command["id"] != "DIFF"
        ]
        evidence["claim_results"][0]["evidence_refs"] = ["INTEGRATION"]
        for defeater in evidence["defeater_results"][:2]:
            defeater["evidence_refs"] = [defeater["evidence_refs"][0]]

        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("focused gate was not executed" in error for error in result.errors))
    def test_fresh_qualification_requires_post_mutant_restoration_order(self):
        contract = load("examples/light-construction/contract.json")
        evidence = load("examples/light-construction/evidence.json")
        commands = evidence["commands"]
        restore = next(command for command in commands if command["id"] == "Q-RESTORE")
        commands.remove(restore)
        bad_index = next(
            index for index, command in enumerate(commands) if command["id"] == "Q-BAD"
        )
        commands.insert(bad_index, restore)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("restoration must run after known-bad rejection" in error for error in result.errors))
    def test_candidate_red_cannot_run_before_oracle_restoration(self):
        contract = load("examples/light-construction/contract.json")
        evidence = load("examples/light-construction/evidence.json")
        commands = evidence["commands"]
        baseline = next(command for command in commands if command["id"] == "BASE-RED")
        commands.remove(baseline)
        restore_index = next(
            index for index, command in enumerate(commands) if command["id"] == "Q-RESTORE"
        )
        commands.insert(restore_index, baseline)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("candidate evidence command BASE-RED" in error for error in result.errors)
        )

    def test_oracle_known_good_must_be_executed(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["commands"] = [
            command for command in evidence["commands"] if command["id"] != "QUAL-DIFF-GOOD"
        ]
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("oracle O-CLI-DIFF known-good" in error for error in result.errors))







    def test_test_discovery_drop_is_rejected(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["test_discovery"]["executed"] -= 1
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("test execution mismatch" in error for error in result.errors))
    def test_coordinated_discovery_drop_is_rejected_against_contract_baseline(self):
        contract = copy.deepcopy(self.contract)
        contract["test_discovery"] = copy.deepcopy(self.evidence["test_discovery"])
        evidence = copy.deepcopy(self.evidence)
        evidence["test_discovery"]["expected"] = 1
        evidence["test_discovery"]["executed"] = 1
        evidence["test_discovery"]["manifest_digest"] = "sha256:changed"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("discovery baseline" in error for error in result.errors))
    def test_environment_identity_drift_is_rejected(self):
        contract = copy.deepcopy(self.contract)
        contract["environment"]["digest"] = self.evidence["environment"]["digest"]
        evidence = copy.deepcopy(self.evidence)
        evidence["environment"]["digest"] = "sha256:changed-environment"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("environment digest differs" in error for error in result.errors))
    def test_fixture_identity_drift_is_rejected(self):
        contract = copy.deepcopy(self.contract)
        contract["fixtures"] = copy.deepcopy(self.evidence["fixtures"])
        evidence = copy.deepcopy(self.evidence)
        evidence["fixtures"][0]["fingerprint"] = "sha256:changed-fixture"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("fixture identities differ" in error for error in result.errors))




    def test_unapproved_skip_is_rejected(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["test_discovery"]["executed"] -= 1
        evidence["test_discovery"]["skipped"] = ["test_malformed_json"]
        evidence["test_discovery"]["approved_skips"] = []
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("unapproved skips" in error for error in result.errors))

    def test_oracle_identity_drift_is_rejected(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["oracles"][0]["fingerprint"] = "sha256:changed"
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("fingerprint differs" in error for error in result.errors))
    def test_contract_semantic_change_invalidates_evidence(self):
        contract = copy.deepcopy(self.contract)
        contract["claims"][0]["statement"] = "Changed semantics without fresh evidence."
        result = vdd_lint.validate_evidence(self.evidence, contract)
        self.assertTrue(any("contract fingerprint" in error for error in result.errors))


    def test_candidate_self_attestation_is_rejected(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["issued_by"]["identity"] = self.contract["roles"]["implementer"]
        evidence["issued_by"]["independent_from_candidate"] = False
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("independent issuer" in error for error in result.errors))
        self.assertTrue(any("does not match contract.roles.acceptor" in error for error in result.errors))
    def test_cli_applies_evidence_schema_before_semantic_lint(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["candidate"]["dirty"] = True
        with tempfile.TemporaryDirectory() as tmp:
            evidence_path = Path(tmp) / "evidence.json"
            evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                exit_code = vdd_lint.main(
                    [
                        "evidence",
                        str(evidence_path),
                        "--contract",
                        str(ROOT / "examples/standard-equivalence/contract.json"),
                    ]
                )
        self.assertEqual(1, exit_code)
        self.assertIn("schema candidate.dirty", output.getvalue())


    def test_light_acceptance_still_requires_control_plane_separation(self):
        contract = load("examples/light-construction/contract.json")
        evidence = load("examples/light-construction/evidence.json")
        evidence["issued_by"]["independent_from_candidate"] = False
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("independent issuer" in error for error in result.errors))

    def test_invalidated_evidence_requires_an_invalidation_event(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["status"] = "invalidated"
        evidence["invalidation_events"] = []
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("requires at least one invalidation event" in error for error in result.errors))

    def test_unknown_claim_cannot_be_accepted(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["claim_results"][0]["status"] = "unknown"
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("cannot leave required claim" in error for error in result.errors))

    def test_surviving_defeater_cannot_be_hidden(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["defeater_results"][0]["status"] = "survived"
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("cannot leave defeater" in error for error in result.errors))
    def test_residual_risk_requires_stage_owner_and_expiry(self):
        contract = copy.deepcopy(self.contract)
        contract["defeaters"][0]["status"] = "accepted_residual"
        contract["defeaters"][0]["risk_owner"] = "risk-owner"
        evidence = copy.deepcopy(self.evidence)
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["defeater_results"][0]["status"] = "accepted_residual"
        evidence["defeater_results"][0]["evidence_refs"] = []
        evidence["residual_risks"] = []
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("risk_acceptance" in error for error in result.errors))
    def test_accepted_residual_requires_matching_evidence_record(self):
        contract = copy.deepcopy(self.contract)
        contract["defeaters"][0]["status"] = "accepted_residual"
        contract["defeaters"][0]["risk_acceptance"] = {
            "owner": "risk-owner",
            "stages": ["merge"],
            "expires_at": "2026-12-31T00:00:00Z",
            "invalidated_by": ["contract change"],
            "rationale": "Accepted for merge while release remains blocked.",
        }
        evidence = copy.deepcopy(self.evidence)
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["defeater_results"][0]["status"] = "accepted_residual"
        evidence["defeater_results"][0]["evidence_refs"] = []
        evidence["residual_risks"] = []
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("missing residual risk record" in error for error in result.errors))
        evidence["residual_risks"] = [
            {
                "defeater_id": contract["defeaters"][0]["id"],
                "stage": "merge",
                "owner": "risk-owner",
                "rationale": "Accepted for merge while release remains blocked.",
                "expires_at": "2026-12-31T00:00:00Z",
                "decision_ref": "RISK-DECISION-1",
                "invalidated_by": ["contract change"],
            }
        ]
        accepted = vdd_lint.validate_evidence(evidence, contract)
        self.assertEqual([], accepted.errors, accepted.errors)
        contract["defeaters"][0]["risk_acceptance"]["expires_at"] = "2026-01-01T00:00:00Z"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["residual_risks"][0]["expires_at"] = "2026-01-01T00:00:00Z"
        expired = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("expired before evidence issuance" in error for error in expired.errors))



    def test_equivalence_requires_mode_specific_evidence(self):
        evidence = copy.deepcopy(self.evidence)
        evidence.pop("mode_evidence", None)
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("equivalence mode_evidence" in error for error in result.errors))
    def test_equivalence_unknown_behavior_blocks_acceptance(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["mode_evidence"]["behavior_classification"]["unknown"] = [
            "undecided malformed-input behavior"
        ]
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("unknown behavior" in error for error in result.errors))
    def test_improvement_inconclusive_metric_cannot_be_accepted(self):
        contract = copy.deepcopy(self.contract)
        contract["mode"] = "improvement"
        contract["oracles"][0]["type"] = "benchmark"
        contract["baseline"] = {
            "semantic_red_command": None,
            "reference_green_command": None,
            "semantic_green_command": "python verifier/diff_cli.py --candidate target/debug/replacement-cli",
            "hard_constraint_commands": ["BROAD"],
            "metric": {
                "name": "latency",
                "direction": "lower",
                "baseline_command": "./verifier/run_packaged_cli.sh candidate",
                "runs": 5,
                "noise_band": "5%",
                "minimum_improvement": "10%",
            },
        }
        evidence = copy.deepcopy(self.evidence)
        evidence["mode"] = "improvement"
        evidence["commands"] = [
            command for command in evidence["commands"] if command["id"] != "REF-GREEN"
        ]
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["mode_evidence"] = {
            "semantic_green_commands": ["DIFF"],
            "hard_constraint_commands": ["BROAD"],
            "fast_path_command": "CHECK",
            "metric_command": "INTEGRATION",
            "metric_result": {
                "name": "latency",
                "direction": "lower",
                "baseline_samples": [100, 101, 99, 100, 102],
                "candidate_samples": [80, 81, 79, 80, 82],
                "noise_band": 5.0,
                "minimum_meaningful_change": 10.0,
                "result": "statistical_inconclusive",
            },
        }
        evidence["mode_evidence"]["metric_result"]["result"] = "improved"
        improved = vdd_lint.validate_evidence(evidence, contract)
        self.assertEqual([], improved.errors, improved.errors)
        fabricated = copy.deepcopy(evidence)
        fabricated["mode_evidence"]["metric_result"]["candidate_samples"] = [
            99,
            100,
            98,
            101,
            100,
        ]
        fabricated_result = vdd_lint.validate_evidence(fabricated, contract)
        self.assertTrue(
            any("contradicts derived result" in error for error in fabricated_result.errors)
        )
        numeric_contract = copy.deepcopy(contract)
        numeric_contract["baseline"]["metric"]["noise_band"] = 5.0
        numeric_contract["baseline"]["metric"]["minimum_improvement"] = 10.0
        numeric_evidence = copy.deepcopy(evidence)
        numeric_evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(
            numeric_contract
        )
        numeric_result = vdd_lint.validate_evidence(numeric_evidence, numeric_contract)
        self.assertEqual([], numeric_result.errors, numeric_result.errors)
        mismatched = copy.deepcopy(evidence)
        mismatched["mode_evidence"]["metric_result"].update(
            {
                "name": "throughput",
                "direction": "higher",
                "baseline_samples": [100, 101, 99],
                "candidate_samples": [120, 121, 119],
                "noise_band": 1.0,
                "minimum_meaningful_change": 1.0,
            }
        )
        mismatch_result = vdd_lint.validate_evidence(mismatched, contract)
        self.assertTrue(any("metric name differs" in error for error in mismatch_result.errors))
        self.assertTrue(any("metric direction differs" in error for error in mismatch_result.errors))
        self.assertTrue(any("requires at least 5 samples" in error for error in mismatch_result.errors))
        self.assertTrue(any("noise band differs" in error for error in mismatch_result.errors))
        self.assertTrue(any("minimum improvement differs" in error for error in mismatch_result.errors))
        evidence["mode_evidence"]["metric_result"]["candidate_samples"] = [
            99,
            100,
            98,
            101,
            100,
        ]
        evidence["mode_evidence"]["metric_result"]["result"] = "statistical_inconclusive"
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("requires an improved metric result" in error for error in result.errors))



    def test_equivalence_cannot_use_characterization_stage(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["stage"] = "characterization"
        evidence["merge"]["integration_passed"] = False
        evidence["merge"]["cutover_complete"] = False
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("stage is incompatible" in error for error in result.errors))

    def test_release_requires_bound_merge_attestation(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["stage"] = "release"
        evidence["merge"]["rollback_exercised"] = True
        evidence["release"] = {
            "canary_or_shadow": "canary-run-7",
            "thresholds_passed": True,
            "rollback_trigger": "error-rate > 1%",
            "release_owner": self.contract["roles"]["release_owner"],
        }
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("parent merge attestation" in error for error in result.errors))

    def test_release_owner_must_match_contract_authority(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["stage"] = "release"
        evidence["merge"]["rollback_exercised"] = True
        evidence["release"] = {
            "canary_or_shadow": "canary-run-7",
            "thresholds_passed": True,
            "rollback_trigger": "error-rate > 1%",
            "release_owner": "unauthorized-owner",
        }
        evidence["parent_attestation"] = {
            "attestation_id": "A-MERGE-001",
            "digest": "sha256:merge",
            "stage": "merge",
            "status": "accepted",
            "contract_fingerprint": evidence["contract"]["fingerprint"],
            "candidate_revision": evidence["candidate"]["revision"],
        }
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("release owner differs" in error for error in result.errors))

    def test_release_gate_declared_by_contract_must_be_executed(self):
        contract = copy.deepcopy(self.contract)
        contract["gates"]["release"] = "python verifier/release_gate.py"
        evidence = copy.deepcopy(self.evidence)
        evidence["stage"] = "release"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["merge"]["rollback_exercised"] = True
        evidence["release"] = {
            "canary_or_shadow": "canary-run-7",
            "thresholds_passed": True,
            "rollback_trigger": "error-rate > 1%",
            "release_owner": contract["roles"]["release_owner"],
        }
        evidence["parent_attestation"] = {
            "attestation_id": "A-MERGE-001",
            "digest": "sha256:merge",
            "stage": "merge",
            "status": "accepted",
            "contract_fingerprint": evidence["contract"]["fingerprint"],
            "candidate_revision": evidence["candidate"]["revision"],
        }
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(any("release gate was not executed" in error for error in result.errors))

    def test_release_requires_canary_thresholds_and_owner(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["stage"] = "release"
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("canary_or_shadow" in error for error in result.errors))
        self.assertTrue(any("thresholds_passed" in error for error in result.errors))
        self.assertTrue(any("release_owner" in error for error in result.errors))

    def test_forbidden_scope_diff_is_rejected(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["forbidden_scope_diff"] = ["verifier/expected.json"]
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(any("forbidden_scope_diff" in error for error in result.errors))

    def test_merge_gate_must_be_executed_for_merge_acceptance(self):
        contract = copy.deepcopy(self.contract)
        contract["gates"]["merge"] = "python verifier/merge_gate.py"
        evidence = copy.deepcopy(self.evidence)
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("merge gate was not executed" in error for error in result.errors),
            result.errors,
        )

    def test_proposal_only_cutover_without_result_command_is_rejected(self):
        evidence = copy.deepcopy(self.evidence)
        evidence["mode_evidence"]["cutover"].pop("result_command", None)
        # Proposal counters remain complete, but no protected producer command.
        result = vdd_lint.validate_evidence(evidence, self.contract)
        self.assertTrue(
            any("cutover result_command" in error for error in result.errors),
            result.errors,
        )

    def test_critical_platform_matrix_requires_authenticated_execution(self):
        contract = copy.deepcopy(self.contract)
        contract["risk_profile"] = "critical"
        contract["roles"]["release_owner"] = "cli-release-owner"
        contract["gates"]["release"] = "python verifier/release_gate.py"
        contract["environment"]["matrix"] = ["linux-x86_64"]
        contract["control_plane"] = {
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "platform_results": {
                "linux-x86_64": {
                    "command_id": "PLATFORM-LINUX",
                    "result_path": "artifacts/linux.json",
                    "producer_path": "verifier/platform_linux.py",
                },
            },
        }
        evidence = copy.deepcopy(self.evidence)
        evidence["risk_profile"] = "critical"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["environment"]["details"]["runtime"] = {
            "system": "linux",
            "machine": "x86_64",
            "platform_id": "linux-x86_64",
        }
        evidence["environment"]["details"].pop("platform_matrix_evidence", None)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("platform matrix" in error for error in result.errors),
            result.errors,
        )


    def test_critical_platform_matrix_rejects_shared_or_uncaptured_results(self):
        contract = copy.deepcopy(self.contract)
        contract["risk_profile"] = "critical"
        contract["roles"]["release_owner"] = "cli-release-owner"
        contract["gates"]["release"] = "python verifier/release_gate.py"
        contract["environment"]["matrix"] = ["linux-x86_64"]
        contract["control_plane"] = {
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "platform_results": {
                "linux-x86_64": {
                    "command_id": "PLATFORM-LINUX",
                    "result_path": "artifacts/linux.json",
                    "producer_path": "verifier/platform_linux.py",
                },
            },
        }
        evidence = copy.deepcopy(self.evidence)
        evidence["risk_profile"] = "critical"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["environment"]["details"]["runtime"] = {
            "system": "linux",
            "machine": "x86_64",
            "platform_id": "linux-x86_64",
        }
        evidence["commands"].append(
            {
                "id": "PLATFORM-LINUX",
                "command": "python verifier/platform_linux.py",
                "exit_code": 0,
                "result": "pass",
                "artifact_refs": ["artifacts/linux.json"],
            }
        )
        evidence["environment"]["details"]["platform_matrix_evidence"] = {
            "linux-x86_64": "PLATFORM-LINUX",
            "macos-arm64": "PLATFORM-LINUX",
        }
        extra = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any(
                "platform matrix" in error and "macos-arm64" in error
                for error in extra.errors
            ),
            extra.errors,
        )

        evidence["environment"]["details"]["platform_matrix_evidence"] = {
            "linux-x86_64": "PLATFORM-LINUX",
        }
        missing_capture = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any(
                "protected platform result" in error and "linux-x86_64" in error
                for error in missing_capture.errors
            ),
            missing_capture.errors,
        )

        evidence["commands"][-1]["captured_result"] = {
            "role": "platform_result:linux-x86_64",
            "path": "artifacts/linux.json",
            "digest": "sha256:" + "2" * 64,
            "value": {"platform": "macos-arm64", "passed": True},
        }
        mismatched = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any(
                "protected platform result" in error and "linux-x86_64" in error
                for error in mismatched.errors
            ),
            mismatched.errors,
        )


    def test_critical_multi_platform_requires_and_accepts_external_authority(self):
        """Multi-host evidence must opt into the external aggregation contract."""
        contract = copy.deepcopy(self.contract)
        contract["risk_profile"] = "critical"
        contract["roles"]["release_owner"] = "cli-release-owner"
        contract["gates"]["release"] = "python verifier/release_gate.py"
        contract["environment"]["matrix"] = ["linux-x86_64", "macos-arm64"]
        contract["control_plane"] = {
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "platform_results": {
                "linux-x86_64": {
                    "command_id": "PLATFORM-LINUX",
                    "result_path": "artifacts/linux.json",
                    "producer_path": "verifier/platform_linux.py",
                },
                "macos-arm64": {
                    "command_id": "PLATFORM-MACOS",
                    "result_path": "artifacts/macos.json",
                    "producer_path": "verifier/platform_macos.py",
                },
            },
        }
        contract_result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any(
                "platform_evidence_authority" in error
                for error in contract_result.errors
            ),
            contract_result.errors,
        )
        contract["environment"][
            "platform_evidence_authority"
        ] = "external-attestation-aggregator"
        authorized_contract = vdd_lint.validate_contract(contract)
        self.assertFalse(
            any(
                "platform_evidence_authority" in error
                for error in authorized_contract.errors
            ),
            authorized_contract.errors,
        )

        evidence = copy.deepcopy(self.evidence)
        evidence["risk_profile"] = "critical"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["environment"]["details"]["runtime"] = {
            "system": "linux",
            "machine": "x86_64",
            "platform_id": "linux-x86_64",
        }
        evidence["commands"].extend(
            [
                {
                    "id": "PLATFORM-LINUX",
                    "command": "python verifier/platform_linux.py",
                    "exit_code": 0,
                    "result": "pass",
                    "artifact_refs": ["artifacts/linux.json"],
                    "captured_result": {
                        "role": "platform_result:linux-x86_64",
                        "path": "artifacts/linux.json",
                        "digest": "sha256:" + "1" * 64,
                        "value": {"platform": "linux-x86_64", "passed": True},
                    },
                },
                {
                    "id": "PLATFORM-MACOS",
                    "command": "python verifier/platform_macos.py",
                    "exit_code": 0,
                    "result": "pass",
                    "artifact_refs": ["artifacts/macos.json"],
                    "captured_result": {
                        "role": "platform_result:macos-arm64",
                        "path": "artifacts/macos.json",
                        "digest": "sha256:" + "2" * 64,
                        "value": {"platform": "macos-arm64", "passed": True},
                    },
                },
            ]
        )
        evidence["environment"]["details"]["platform_matrix_evidence"] = {
            "linux-x86_64": "PLATFORM-LINUX",
            "macos-arm64": "PLATFORM-MACOS",
        }
        evidence["environment"]["details"]["platform_attestation_digests"] = {
            "linux-x86_64": "sha256:" + "3" * 64,
            "macos-arm64": "sha256:" + "4" * 64,
        }
        evidence_result = vdd_lint.validate_evidence(evidence, contract)
        self.assertFalse(
            any(
                "platform_evidence_authority" in error
                or "lacks attestation digests" in error
                for error in evidence_result.errors
            ),
            evidence_result.errors,
        )

    def test_critical_external_platform_attestation_digests_must_be_canonical(self):
        contract = copy.deepcopy(self.contract)
        contract["risk_profile"] = "critical"
        contract["roles"]["release_owner"] = "cli-release-owner"
        contract["gates"]["release"] = "python verifier/release_gate.py"
        contract["environment"]["matrix"] = ["linux-x86_64", "macos-arm64"]
        contract["environment"][
            "platform_evidence_authority"
        ] = "external-attestation-aggregator"
        contract["control_plane"] = {
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "platform_results": {
                "linux-x86_64": {
                    "command_id": "PLATFORM-LINUX",
                    "result_path": "artifacts/linux.json",
                    "producer_path": "verifier/platform_linux.py",
                },
                "macos-arm64": {
                    "command_id": "PLATFORM-MACOS",
                    "result_path": "artifacts/macos.json",
                    "producer_path": "verifier/platform_macos.py",
                },
            },
        }
        evidence = copy.deepcopy(self.evidence)
        evidence["risk_profile"] = "critical"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["environment"]["details"]["runtime"] = {
            "system": "linux",
            "machine": "x86_64",
            "platform_id": "linux-x86_64",
        }
        evidence["commands"].extend(
            [
                {
                    "id": "PLATFORM-LINUX",
                    "command": "python verifier/platform_linux.py",
                    "exit_code": 0,
                    "result": "pass",
                    "artifact_refs": ["artifacts/linux.json"],
                    "captured_result": {
                        "role": "platform_result:linux-x86_64",
                        "path": "artifacts/linux.json",
                        "digest": "sha256:" + "1" * 64,
                        "value": {"platform": "linux-x86_64", "passed": True},
                    },
                },
                {
                    "id": "PLATFORM-MACOS",
                    "command": "python verifier/platform_macos.py",
                    "exit_code": 0,
                    "result": "pass",
                    "artifact_refs": ["artifacts/macos.json"],
                    "captured_result": {
                        "role": "platform_result:macos-arm64",
                        "path": "artifacts/macos.json",
                        "digest": "sha256:" + "2" * 64,
                        "value": {"platform": "macos-arm64", "passed": True},
                    },
                },
            ]
        )
        evidence["environment"]["details"]["platform_matrix_evidence"] = {
            "linux-x86_64": "PLATFORM-LINUX",
            "macos-arm64": "PLATFORM-MACOS",
        }
        evidence["environment"]["details"]["platform_attestation_digests"] = {
            "linux-x86_64": "not-a-digest",
            "macos-arm64": "sha256:deadbeef",
        }
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any(
                "attestation digests" in error
                and "sha256" in error
                and "linux-x86_64" in error
                and "macos-arm64" in error
                for error in result.errors
            ),
            result.errors,
        )




    def test_improvement_rejects_unrelated_hard_constraint_commands(self):
        contract = copy.deepcopy(self.contract)
        contract["mode"] = "improvement"
        contract["oracles"][0]["type"] = "benchmark"
        contract["baseline"] = {
            "semantic_red_command": None,
            "reference_green_command": None,
            "semantic_green_command": "python verifier/diff_cli.py --candidate target/debug/replacement-cli",
            "hard_constraint_commands": ["HARD-CONSTRAINT"],
            "metric": {
                "name": "latency",
                "direction": "lower",
                "baseline_command": "./verifier/run_packaged_cli.sh candidate",
                "runs": 5,
                "noise_band": "5%",
                "minimum_improvement": "10%",
            },
        }
        evidence = copy.deepcopy(self.evidence)
        evidence["mode"] = "improvement"
        evidence["commands"] = [
            command for command in evidence["commands"] if command["id"] != "REF-GREEN"
        ]
        evidence["commands"].append(
            {
                "id": "HARD-CONSTRAINT",
                "command": "python verifier/hard_constraints.py",
                "exit_code": 0,
                "result": "pass",
                "artifact_refs": ["hard.json"],
            }
        )
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["mode_evidence"] = {
            "semantic_green_commands": ["DIFF"],
            "hard_constraint_commands": ["BROAD"],
            "fast_path_command": "CHECK",
            "metric_command": "INTEGRATION",
            "metric_result": {
                "name": "latency",
                "direction": "lower",
                "baseline_samples": [100, 101, 99, 100, 102],
                "candidate_samples": [80, 81, 79, 80, 82],
                "noise_band": 5.0,
                "minimum_meaningful_change": 10.0,
                "result": "improved",
            },
        }
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("hard-constraint" in error and "HARD-CONSTRAINT" in error for error in result.errors),
            result.errors,
        )

    def test_duplicate_skip_ids_are_rejected_before_completeness(self):
        contract = copy.deepcopy(self.contract)
        contract["test_discovery"]["approved_skips"] = ["flaky_a"]
        evidence = copy.deepcopy(self.evidence)
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["test_discovery"]["executed"] = 122
        evidence["test_discovery"]["skipped"] = ["flaky_a", "flaky_a"]
        evidence["test_discovery"]["approved_skips"] = ["flaky_a"]
        evidence["test_discovery"]["shards"][0]["executed"] = 122
        evidence["test_discovery"]["shards"][0]["skipped"] = ["flaky_a", "flaky_a"]
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("duplicate" in error and "skip" in error for error in result.errors),
            result.errors,
        )

    def test_critical_release_requires_protected_result_command(self):
        contract = copy.deepcopy(self.contract)
        contract["risk_profile"] = "critical"
        contract["roles"]["release_owner"] = "cli-release-owner"
        contract["gates"]["release"] = "python verifier/release_gate.py"
        contract["environment"]["matrix"] = ["linux-x86_64"]
        contract["control_plane"] = {
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "platform_results": {
                "linux-x86_64": {
                    "command_id": "PLATFORM-LINUX",
                    "result_path": "artifacts/linux.json",
                    "producer_path": "verifier/platform_linux.py",
                }
            },
        }
        evidence = copy.deepcopy(self.evidence)
        evidence["risk_profile"] = "critical"
        evidence["stage"] = "release"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["merge"]["rollback_exercised"] = True
        evidence["release"] = {
            "canary_or_shadow": "canary-run-7",
            "thresholds_passed": True,
            "rollback_trigger": "error-rate > 1%",
            "release_owner": "cli-release-owner",
        }
        evidence["parent_attestation"] = {
            "attestation_id": "A-MERGE-001",
            "digest": "sha256:" + "a" * 64,
            "stage": "merge",
            "status": "accepted",
            "contract_fingerprint": evidence["contract"]["fingerprint"],
            "candidate_revision": evidence["candidate"]["revision"],
        }
        evidence["commands"].extend(
            [
                {
                    "id": "RELEASE-GATE",
                    "command": "python verifier/release_gate.py",
                    "exit_code": 0,
                    "result": "pass",
                    "artifact_refs": ["release-gate.log"],
                },
                {
                    "id": "PLATFORM-LINUX",
                    "command": "python verifier/platform_linux.py",
                    "exit_code": 0,
                    "result": "pass",
                    "artifact_refs": ["artifacts/linux.json"],
                    "captured_result": {
                        "role": "platform_result:linux-x86_64",
                        "path": "artifacts/linux.json",
                        "digest": "sha256:" + "3" * 64,
                        "value": {"platform": "linux-x86_64", "passed": True},
                    },
                },
            ]
        )
        evidence["environment"]["details"]["runtime"] = {
            "system": "linux",
            "machine": "x86_64",
            "platform_id": "linux-x86_64",
        }
        evidence["environment"]["details"]["platform_matrix_evidence"] = {
            "linux-x86_64": "PLATFORM-LINUX",
        }
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("release result_command" in error for error in result.errors),
            result.errors,
        )

    def test_critical_platform_matrix_key_must_match_runtime_platform_id(self):
        contract = copy.deepcopy(self.contract)
        contract["risk_profile"] = "critical"
        contract["roles"]["release_owner"] = "cli-release-owner"
        contract["gates"]["release"] = "python verifier/release_gate.py"
        contract["environment"]["matrix"] = ["linux-x86_64"]
        contract["control_plane"] = {
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "platform_results": {
                "linux-x86_64": {
                    "command_id": "PLATFORM-LINUX",
                    "result_path": "artifacts/linux.json",
                    "producer_path": "verifier/platform_linux.py",
                }
            },
        }
        evidence = copy.deepcopy(self.evidence)
        evidence["risk_profile"] = "critical"
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["environment"]["details"]["runtime"] = {
            "system": "macos",
            "machine": "arm64",
            "platform_id": "macos-arm64",
        }
        evidence["commands"].append(
            {
                "id": "PLATFORM-LINUX",
                "command": "python verifier/platform_linux.py",
                "exit_code": 0,
                "result": "pass",
                "artifact_refs": ["artifacts/linux.json"],
                "captured_result": {
                    "role": "platform_result:linux-x86_64",
                    "path": "artifacts/linux.json",
                    "digest": "sha256:" + "4" * 64,
                    "value": {"platform": "linux-x86_64", "passed": True},
                },
            }
        )
        evidence["environment"]["details"]["platform_matrix_evidence"] = {
            "linux-x86_64": "PLATFORM-LINUX",
        }
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any(
                "platform_id" in error and "linux-x86_64" in error
                for error in result.errors
            ),
            result.errors,
        )




if __name__ == "__main__":
    unittest.main()
