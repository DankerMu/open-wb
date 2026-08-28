from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]


def load(relative: str) -> dict:
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


class MigrationSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = Draft202012Validator(load("schemas/migration-manifest.schema.json"))
        cls.classification = Draft202012Validator(
            load("schemas/source-classification.schema.json")
        )

    def test_manifest_accepts_domain_facts_without_execution_state(self):
        manifest = {
            "schemaVersion": "code-migration-3",
            "migrationId": "MIG-001",
            "revision": "manifest@1",
            "variant": "structure-preserving-port",
            "source": {"root": "legacy", "stack": "C", "version": "C11", "revision": "git:abc"},
            "target": {"root": "target", "stack": "Rust", "version": "1.80"},
            "scope": {
                "source": {"includes": ["legacy/src"], "excludes": []},
                "target": {"includes": ["target/src"], "excludes": []},
                "externalConsumers": [],
            },
            "units": [
                {
                    "id": "U-PARSER",
                    "kind": "module",
                    "sourcePaths": ["legacy/src/parser.c"],
                    "targetPaths": ["target/src/parser.rs"],
                    "dependencies": [],
                    "sharedSeamOwner": "parser-owner",
                    "risk": "high",
                    "classificationIds": ["B-PARSER-001"],
                    "artifactRefs": ["RULEBOOK.md#parser"]
                }
            ],
            "invalidatedBy": ["reference revision", "rulebook revision"]
        }
        self.assertEqual([], list(self.manifest.iter_errors(manifest)))
        runtime_manifest = copy.deepcopy(manifest)
        runtime_manifest["status"] = "queued"
        self.assertTrue(list(self.manifest.iter_errors(runtime_manifest)))

    def test_missions_v4_pack_request_requires_explicit_gates_and_static_artifact_identities(self):
        request_validator = Draft202012Validator(load("schemas/missions-v4-pack-request.schema.json"))
        request = {
            "schemaVersion": "code-migration-missions-v4-2",
            "migrationId": "MIG-001",
            "repository": {
                "canonicalRealPath": "/workspace/target-repository",
                "baselineCommit": "0" * 40,
            },
            "plan": {
                "id": "migration-pilot-001",
                "revision": 1,
                "phase": "pilot",
                "milestone": "pilot",
                "units": [
                    {
                        "id": "U-PARSER",
                        "skillName": "parser-worker",
                        "skillFiles": [
                            {"artifactRef": "skills/parser-worker/SKILL.md", "digest": "sha256:" + "1" * 64}
                        ],
                        "verification": {
                            "mode": "steps",
                            "steps": [{"id": "unit-test", "command": "python3 -m unittest", "expectedExit": "zero"}],
                        },
                        "qaFlows": [
                            {
                                "id": "parser-flow",
                                "artifact": {"artifactRef": "qa/parser-flow.md", "digest": "sha256:" + "2" * 64},
                                "passCriteria": [{"id": "result", "text": "Parser output is correct."}],
                            }
                        ],
                    }
                ],
                "budgets": {"maxAttemptsPerFeature": 3, "maxRepairRoundsPerMilestone": 2},
                "reviewPolicy": {
                    "scrutiny": "required",
                    "checklist": [{"id": "scope", "text": "Review the approved scope."}],
                },
            },
            "g1JudgeQualification": {
                "artifact": {"artifactRef": "evidence/g1.json", "digest": "sha256:" + "a" * 64},
                "knownGood": {"id": "known-good", "command": "test-good", "expectedExit": "zero"},
                "knownBad": {"id": "known-bad", "command": "test-bad", "expectedExit": "nonzero"},
                "restoration": {"id": "restored", "command": "test-restored", "expectedExit": "zero"},
            },
            "g2Approval": {
                "artifact": {"artifactRef": "approval/g2.json", "digest": "sha256:" + "b" * 64},
                "approvedBy": "contract-owner",
                "approvedAt": "2026-07-18T00:00:00Z",
            },
            "migrationArtifacts": {
                "manifest": {"artifactRef": "manifest.json", "digest": "sha256:" + "c" * 64},
                "sourceClassification": {"artifactRef": "source-classification.json", "digest": "sha256:" + "d" * 64},
                "routeArtifacts": {
                    "rulebook": {"artifactRef": "RULEBOOK.md", "digest": "sha256:" + "e" * 64},
                    "gapInventory": {"artifactRef": "gap-inventory.tsv", "digest": "sha256:" + "f" * 64},
                },
                "vddBinding": {"artifactRef": "vdd/binding.json", "digest": "sha256:" + "0" * 64},
            },
        }
        self.assertEqual([], list(request_validator.iter_errors(request)))
        for field in ("g1JudgeQualification", "g2Approval", "repository"):
            with self.subTest(field=field):
                missing = copy.deepcopy(request)
                missing.pop(field)
                self.assertTrue(list(request_validator.iter_errors(missing)))
        runtime_request = copy.deepcopy(request)
        runtime_request["lease"] = "illegal"
        self.assertTrue(list(request_validator.iter_errors(runtime_request)))
        for name, mutate, target in (
            ("malformed-repository", lambda value: value.update({"baselineCommit": "invalid"}), "repository"),
            ("legacy-route-artifact", lambda value: value.update({"routeArtifact": {"kind": "rulebook"}}), "migrationArtifacts"),
            ("missing-units", lambda plan: plan.pop("units"), "plan"),
            ("legacy-unit-ids", lambda plan: plan.update({"unitIds": ["U-PARSER"]}), "plan"),
            ("missing-verification", lambda plan: plan["units"][0].pop("verification"), "plan"),
            ("none-verification", lambda plan: plan["units"][0].update({"verification": {"mode": "none", "steps": []}}), "plan"),
            ("skill-without-files", lambda plan: plan["units"][0].update({"skillFiles": []}), "plan"),
            ("qa-without-criteria", lambda plan: plan["units"][0]["qaFlows"][0].update({"passCriteria": []}), "plan"),
        ):
            with self.subTest(name=name):
                invalid = copy.deepcopy(request)
                mutate(invalid[target])
                self.assertTrue(list(request_validator.iter_errors(invalid)))

    def test_missions_v4_templates_preserve_v2_repository_and_route_bindings(self):
        digest = "sha256:" + "a" * 64

        def concrete(value):
            if isinstance(value, dict):
                return {key: concrete(item) for key, item in value.items()}
            if isinstance(value, list):
                return [concrete(item) for item in value]
            if isinstance(value, str) and value.startswith("sha256:"):
                return digest
            return value

        request_validator = Draft202012Validator(load("schemas/missions-v4-pack-request.schema.json"))
        gate_validator = Draft202012Validator(load("schemas/missions-v4-gate-artifact.schema.json"))
        request = concrete(load("templates/missions-v4-pack-request.json"))
        g1 = concrete(load("templates/G1_JUDGE_QUALIFICATION.json"))
        g2 = concrete(load("templates/G2_PLAN_APPROVAL.json"))

        self.assertEqual([], list(request_validator.iter_errors(request)))
        self.assertEqual([], list(gate_validator.iter_errors(g1)))
        self.assertEqual([], list(gate_validator.iter_errors(g2)))
        self.assertEqual(request["repository"], g1["repository"])
        self.assertEqual(request["repository"], g2["repository"])
        self.assertEqual(request["migrationArtifacts"]["routeArtifacts"], g1["routeArtifacts"])
        self.assertEqual(request["migrationArtifacts"]["routeArtifacts"], g2["routeArtifacts"])

    def test_corrected_behavior_requires_decision_owner_and_unknown_has_none(self):
        classification = {
            "schemaVersion": "code-migration-3",
            "migrationId": "MIG-001",
            "referenceRevision": "git:abc",
            "behaviors": [
                {
                    "id": "B-001",
                    "statement": "Malformed input returns an error without output.",
                    "sourceCitations": ["legacy/src/parser.c:42"],
                    "disposition": "corrected",
                    "rationale": "Legacy leaks partial output.",
                    "decisionOwner": "contract-owner",
                    "targetObligation": "Return structured error before emitting output.",
                    "vddClaimIds": ["C-PARSER"],
                    "vddOracleIds": ["O-PARSER-DIFF"],
                    "blockingStage": "batch",
                    "invalidatedBy": ["contract change"]
                }
            ]
        }
        self.assertEqual([], list(self.classification.iter_errors(classification)))
        missing_owner = copy.deepcopy(classification)
        missing_owner["behaviors"][0]["decisionOwner"] = None
        self.assertTrue(list(self.classification.iter_errors(missing_owner)))
        accepted_without_owner = copy.deepcopy(classification)
        accepted_without_owner["behaviors"][0]["disposition"] = "accepted"
        accepted_without_owner["behaviors"][0]["decisionOwner"] = ""
        self.assertTrue(list(self.classification.iter_errors(accepted_without_owner)))
        whitespace_owner = copy.deepcopy(classification)
        whitespace_owner["behaviors"][0]["decisionOwner"] = " \t"
        self.assertTrue(list(self.classification.iter_errors(whitespace_owner)))

    def test_blocking_stage_uses_vdd_migration_stages(self):
        classification = {
            "schemaVersion": "code-migration-3",
            "migrationId": "MIG-001",
            "referenceRevision": "git:abc",
            "behaviors": [
                {
                    "id": "B-001",
                    "statement": "Malformed input returns an error without output.",
                    "sourceCitations": ["legacy/src/parser.c:42"],
                    "disposition": "unknown",
                    "rationale": "The source contract has not been resolved.",
                    "decisionOwner": None,
                    "targetObligation": "Resolve before accepting the affected batch.",
                    "vddClaimIds": ["C-PARSER"],
                    "vddOracleIds": ["O-PARSER-DIFF"],
                    "blockingStage": "batch",
                    "invalidatedBy": ["contract decision"],
                }
            ],
        }
        self.assertEqual([], list(self.classification.iter_errors(classification)))

        for invalid_stage in ("bootstrap", "completion", "cutover", "release", "pilot", "wave"):
            with self.subTest(invalid_stage=invalid_stage):
                invalid = copy.deepcopy(classification)
                invalid["behaviors"][0]["blockingStage"] = invalid_stage
                self.assertTrue(list(self.classification.iter_errors(invalid)))

        old_field = copy.deepcopy(classification)
        behavior = old_field["behaviors"][0]
        behavior["blockingPhase"] = behavior.pop("blockingStage")
        self.assertTrue(list(self.classification.iter_errors(old_field)))


if __name__ == "__main__":
    unittest.main()
