from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]


def load(relative: str) -> dict:
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


class SchemaValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract_schema = load("schemas/contract.schema.json")
        cls.evidence_schema = load("schemas/evidence.schema.json")
        Draft202012Validator.check_schema(cls.contract_schema)
        Draft202012Validator.check_schema(cls.evidence_schema)
        cls.contract_validator = Draft202012Validator(cls.contract_schema)
        cls.evidence_validator = Draft202012Validator(cls.evidence_schema)

    def test_reference_examples_satisfy_deep_schemas(self):
        for directory in ["light-construction", "standard-equivalence"]:
            with self.subTest(directory=directory, artifact="contract"):
                errors = list(
                    self.contract_validator.iter_errors(
                        load(f"examples/{directory}/contract.json")
                    )
                )
                self.assertEqual([], errors)
            with self.subTest(directory=directory, artifact="evidence"):
                errors = list(
                    self.evidence_validator.iter_errors(
                        load(f"examples/{directory}/evidence.json")
                    )
                )
                self.assertEqual([], errors)

    def test_characterization_and_improvement_shapes_match_protocol(self):
        characterization = load("examples/light-construction/evidence.json")
        characterization["mode"] = "characterization"
        characterization["stage"] = "characterization"
        characterization["mode_evidence"] = {
            "known_good_commands": ["Q-GOOD"],
            "known_bad_commands": ["Q-BAD"],
            "stability_trials": 1,
            "unknowns": [],
            "reusable_artifacts": ["baseline.json"],
        }
        self.assertEqual(
            [],
            list(self.evidence_validator.iter_errors(characterization)),
        )

        improvement = load("examples/standard-equivalence/evidence.json")
        improvement["mode"] = "improvement"
        improvement["mode_evidence"] = {
            "semantic_green_commands": ["DIFF"],
            "hard_constraint_commands": ["BROAD"],
            "fast_path_command": "CHECK",
            "metric_command": "INTEGRATION",
            "metric_result": {
                "name": "latency",
                "direction": "lower",
                "baseline_samples": [100, 101, 99],
                "candidate_samples": [80, 81, 79],
                "noise_band": 2.0,
                "minimum_meaningful_change": 10.0,
                "result": "improved",
            },
        }
        self.assertEqual(
            [],
            list(self.evidence_validator.iter_errors(improvement)),
        )

    def test_contract_rejects_unbounded_candidate_capabilities(self):
        contract = load("examples/light-construction/contract.json")
        contract["candidate_capabilities"].pop("allowed_commands")
        errors = list(self.contract_validator.iter_errors(contract))
        self.assertTrue(
            any(error.validator == "required" and "allowed_commands" in error.message for error in errors),
            errors,
        )

    def test_fresh_qualification_requires_restore_check(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["oracles"][0]["qualification"].pop("restore_command")
        errors = list(self.contract_validator.iter_errors(contract))
        self.assertTrue(errors)

    def test_accepted_evidence_requires_candidate_artifact_identity(self):
        evidence = load("examples/light-construction/evidence.json")
        evidence["candidate"]["artifact_digests"] = []
        errors = list(self.evidence_validator.iter_errors(evidence))
        self.assertTrue(
            any(list(error.path) == ["candidate", "artifact_digests"] for error in errors),
            errors,
        )

    def test_construction_evidence_requires_red_and_boundary_commands(self):
        evidence = load("examples/light-construction/evidence.json")
        evidence["mode_evidence"] = {}
        errors = list(self.evidence_validator.iter_errors(evidence))
        required_fields = {
            field
            for error in errors
            if error.validator == "required"
            for field in ["semantic_red_command", "focused_green_commands", "boundary_commands"]
            if field in error.message
        }
        self.assertEqual(
            {"semantic_red_command", "focused_green_commands", "boundary_commands"},
            required_fields,
        )

    def test_residual_risk_shapes_match_protocol(self):
        contract = load("examples/standard-equivalence/contract.json")
        contract["defeaters"][0]["status"] = "accepted_residual"
        contract["defeaters"][0]["risk_acceptance"] = {
            "owner": "risk-owner",
            "stages": ["merge"],
            "rationale": "Accepted for merge only.",
            "expires_at": "2026-12-31T00:00:00Z",
            "invalidated_by": ["contract change"],
        }
        self.assertEqual([], list(self.contract_validator.iter_errors(contract)))

        evidence = load("examples/standard-equivalence/evidence.json")
        evidence["residual_risks"] = [
            {
                "defeater_id": "D-EXIT-CODE",
                "stage": "merge",
                "owner": "risk-owner",
                "rationale": "Accepted for merge only.",
                "expires_at": "2026-12-31T00:00:00Z",
                "decision_ref": "RISK-DECISION-1",
                "invalidated_by": ["contract change"],
            }
        ]
        self.assertEqual([], list(self.evidence_validator.iter_errors(evidence)))

    def test_blocked_release_can_record_failed_thresholds(self):
        evidence = load("examples/standard-equivalence/evidence.json")
        evidence["stage"] = "release"
        evidence["status"] = "blocked"
        evidence["release"] = {
            "canary_or_shadow": "canary-run-7",
            "thresholds_passed": False,
            "rollback_trigger": "error-rate > 1%",
            "release_owner": "cli-release-owner",
        }
        errors = list(self.evidence_validator.iter_errors(evidence))
        self.assertEqual([], errors)

    def test_control_plane_schema_matches_supported_runtime_results(self):
        contract = load("examples/light-construction/contract.json")
        contract["control_plane"] = {
            "candidate_artifacts": ["src/slug.py"],
            "protected_assets": [
                {
                    "path": "verifier/test_slug.py",
                    "fingerprint": "sha256:" + "1" * 64,
                }
            ],
            "allowed_output_paths": ["artifacts/discovery.json"],
            "environment_allowlist": ["PATH"],
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "execution_plan": [
                {
                    "id": "DISCOVERY",
                    "display": "discover tests",
                    "argv": ["python", "verifier/discover.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["artifacts/discovery.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ],
        }
        self.assertEqual([], list(self.contract_validator.iter_errors(contract)))
        contract["control_plane"]["execution_plan"][0]["result"] = "blocked"
        errors = list(self.contract_validator.iter_errors(contract))
        self.assertTrue(any(error.validator == "enum" for error in errors), errors)

    def test_execution_plan_write_paths_are_required_and_strict(self):
        contract = load("examples/light-construction/contract.json")
        contract["control_plane"] = {
            "candidate_artifacts": ["src/slug.py"],
            "protected_assets": [
                {
                    "path": "verifier/test_slug.py",
                    "fingerprint": "sha256:" + "1" * 64,
                }
            ],
            "allowed_output_paths": ["artifacts/discovery.json"],
            "environment_allowlist": ["PATH"],
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "execution_plan": [
                {
                    "id": "DISCOVERY",
                    "display": "discover tests",
                    "argv": ["python", "verifier/discover.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": ["artifacts/discovery.json"],
                    "artifact_refs": ["artifacts/discovery.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ],
        }
        self.assertEqual([], list(self.contract_validator.iter_errors(contract)))
        contract["control_plane"]["execution_plan"][0].pop("write_paths")
        errors = list(self.contract_validator.iter_errors(contract))
        self.assertTrue(any(error.validator == "required" for error in errors), errors)
        contract["control_plane"]["execution_plan"][0]["write_paths"] = "artifacts/discovery.json"
        errors = list(self.contract_validator.iter_errors(contract))
        self.assertTrue(any(error.validator == "type" for error in errors), errors)

    def test_execution_plan_timeout_matches_control_plane_runtime(self):
        contract = load("examples/light-construction/contract.json")
        contract["control_plane"] = {
            "candidate_artifacts": ["src/slug.py"],
            "protected_assets": [
                {
                    "path": "verifier/test_slug.py",
                    "fingerprint": "sha256:" + "1" * 64,
                }
            ],
            "allowed_output_paths": ["artifacts/discovery.json"],
            "environment_allowlist": ["PATH"],
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "execution_plan": [
                {
                    "id": "DISCOVERY",
                    "display": "discover tests",
                    "argv": ["python", "verifier/discover.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 5,
                    "write_paths": ["artifacts/discovery.json"],
                    "artifact_refs": ["artifacts/discovery.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ],
        }
        self.assertEqual([], list(self.contract_validator.iter_errors(contract)))

        contract["control_plane"]["execution_plan"][0]["timeout_seconds"] = 0
        errors = list(self.contract_validator.iter_errors(contract))
        self.assertTrue(any(error.validator == "minimum" for error in errors), errors)

    def test_fresh_qualification_schema_requires_known_bad_case(self):
        contract = load("examples/light-construction/contract.json")
        contract["oracles"][0]["qualification"]["known_bad_cases"] = []
        errors = list(self.contract_validator.iter_errors(contract))
        self.assertTrue(errors)

    def test_cutover_evidence_schema_requires_protected_result_command(self):
        evidence = load("examples/standard-equivalence/evidence.json")
        evidence["mode_evidence"]["cutover"].pop("result_command", None)
        errors = list(self.evidence_validator.iter_errors(evidence))
        self.assertTrue(errors)

    def test_control_plane_accepts_cutover_and_release_result_plans(self):
        contract = load("examples/light-construction/contract.json")
        contract["control_plane"] = {
            "candidate_artifacts": ["src/slug.py"],
            "protected_assets": [
                {
                    "path": "verifier/test_slug.py",
                    "fingerprint": "sha256:" + "1" * 64,
                }
            ],
            "allowed_output_paths": [
                "artifacts/discovery.json",
                "artifacts/cutover.json",
                "artifacts/release.json",
            ],
            "environment_allowlist": ["PATH"],
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
                "producer_path": "verifier/discover.py",
            },
            "cutover_result": {
                "command_id": "CUTOVER",
                "result_path": "artifacts/cutover.json",
                "producer_path": "verifier/cutover_report.py",
            },
            "release_result": {
                "command_id": "RELEASE",
                "result_path": "artifacts/release.json",
                "producer_path": "verifier/release_report.py",
            },
            "execution_plan": [
                {
                    "id": "DISCOVERY",
                    "display": "discover tests",
                    "argv": ["python", "verifier/discover.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["artifacts/discovery.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                },
                {
                    "id": "CUTOVER",
                    "display": "cutover inventory",
                    "argv": ["python", "verifier/cutover_report.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["artifacts/cutover.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                },
                {
                    "id": "RELEASE",
                    "display": "release thresholds",
                    "argv": ["python", "verifier/release_report.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["artifacts/release.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                },
            ],
        }
        self.assertEqual([], list(self.contract_validator.iter_errors(contract)))

    def test_discovery_plan_schema_requires_producer_path(self):
        contract = load("examples/light-construction/contract.json")
        contract["control_plane"] = {
            "candidate_artifacts": ["src/slug.py"],
            "protected_assets": [
                {
                    "path": "verifier/test_slug.py",
                    "fingerprint": "sha256:" + "1" * 64,
                }
            ],
            "allowed_output_paths": ["artifacts/discovery.json"],
            "environment_allowlist": ["PATH"],
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "artifacts/discovery.json",
            },
            "execution_plan": [
                {
                    "id": "DISCOVERY",
                    "display": "discover tests",
                    "argv": ["python", "verifier/discover.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["artifacts/discovery.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ],
        }
        errors = list(self.contract_validator.iter_errors(contract))
        self.assertTrue(
            any(
                list(error.path)[-1:] == ["producer_path"]
                or "producer_path" in error.message
                for error in errors
            ),
            errors,
        )

    def test_control_plane_schema_accepts_platform_results(self):
        contract = load("examples/light-construction/contract.json")
        contract["control_plane"] = {
            "candidate_artifacts": ["src/slug.py"],
            "protected_assets": [
                {
                    "path": "verifier/test_slug.py",
                    "fingerprint": "sha256:" + "1" * 64,
                }
            ],
            "allowed_output_paths": [
                "artifacts/discovery.json",
                "artifacts/linux.json",
                "artifacts/macos.json",
            ],
            "environment_allowlist": ["PATH"],
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
            "execution_plan": [
                {
                    "id": "DISCOVERY",
                    "display": "discover tests",
                    "argv": ["python", "verifier/discover.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["artifacts/discovery.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ],
        }
        self.assertEqual([], list(self.contract_validator.iter_errors(contract)))




if __name__ == "__main__":
    unittest.main()
