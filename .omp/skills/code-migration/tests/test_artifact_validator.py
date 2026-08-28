from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "tools" / "validate_artifacts.py"


def valid_manifest() -> dict:
    return {
        "schemaVersion": "code-migration-3",
        "migrationId": "MIG-001",
        "revision": "manifest@1",
        "variant": "structure-preserving-port",
        "source": {
            "root": "legacy",
            "stack": "C",
            "version": "C11",
            "revision": "git:abc",
        },
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
                "artifactRefs": ["RULEBOOK.md#parser"],
            },
            {
                "id": "U-LEXER",
                "kind": "module",
                "sourcePaths": ["legacy/src/lexer.c"],
                "targetPaths": ["target/src/lexer.rs"],
                "dependencies": ["U-PARSER"],
                "sharedSeamOwner": "lexer-owner",
                "risk": "medium",
                "classificationIds": ["B-LEXER-001"],
                "artifactRefs": ["RULEBOOK.md#lexer"],
            },
        ],
        "invalidatedBy": ["reference revision", "rulebook revision"],
    }


def valid_classification() -> dict:
    def behavior(identifier: str) -> dict:
        return {
            "id": identifier,
            "statement": f"Observable behavior {identifier} is preserved.",
            "sourceCitations": ["legacy/src/parser.c:42"],
            "disposition": "accepted",
            "rationale": "The behavior is part of the supported contract.",
            "decisionOwner": "contract-owner",
            "targetObligation": "Preserve the observable result.",
            "vddClaimIds": [f"C-{identifier}"],
            "vddOracleIds": ["O-DIFF"],
            "blockingStage": "batch",
            "invalidatedBy": ["contract change"],
        }

    return {
        "schemaVersion": "code-migration-3",
        "migrationId": "MIG-001",
        "referenceRevision": "git:abc",
        "behaviors": [behavior("B-PARSER-001"), behavior("B-LEXER-001")],
    }


class ArtifactValidatorCliTests(unittest.TestCase):
    def run_validator(self, manifest: dict, classification: dict, rulebook: str | None = None) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "manifest.json"
            classification_path = root / "source-classification.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            classification_path.write_text(json.dumps(classification), encoding="utf-8")
            environment = os.environ.copy()
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            arguments = [
                sys.executable,
                str(VALIDATOR),
                "--manifest",
                str(manifest_path),
                "--classification",
                str(classification_path),
            ]
            if rulebook is not None:
                rulebook_path = root / "RULEBOOK.md"
                rulebook_path.write_text(rulebook, encoding="utf-8")
                arguments.extend(["--rulebook", str(rulebook_path)])
            return subprocess.run(
                arguments,
                cwd=ROOT,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )

    def assert_invalid(self, manifest: dict, classification: dict, message: str) -> None:
        result = self.run_validator(manifest, classification)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn(message, result.stderr)

    def test_accepts_schema_valid_semantically_consistent_artifacts(self):
        result = self.run_validator(valid_manifest(), valid_classification())
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("Artifact validation passed", result.stdout)

    def test_rejects_duplicate_unit_ids(self):
        manifest = valid_manifest()
        manifest["units"][1]["id"] = "U-PARSER"
        self.assert_invalid(manifest, valid_classification(), "duplicate unit ID 'U-PARSER'")

    def test_rejects_duplicate_behavior_ids(self):
        classification = valid_classification()
        classification["behaviors"][1]["id"] = "B-PARSER-001"
        self.assert_invalid(valid_manifest(), classification, "duplicate behavior ID 'B-PARSER-001'")

    def test_rejects_unit_id_outside_the_missions_safe_charset(self):
        for bad in ("unit one", "auth/session", "-leading", "U-1\n"):
            with self.subTest(unit_id=bad):
                manifest = valid_manifest()
                manifest["units"][0]["id"] = bad
                for unit in manifest["units"]:
                    unit["dependencies"] = [
                        bad if dependency == "U-PARSER" else dependency
                        for dependency in unit.get("dependencies", [])
                    ]
                self.assert_invalid(manifest, valid_classification(), "not Missions-safe")

    def test_rejects_behavior_id_outside_the_missions_safe_charset(self):
        classification = valid_classification()
        classification["behaviors"][0]["id"] = "behavior one"
        manifest = valid_manifest()
        for unit in manifest["units"]:
            unit["classificationIds"] = [
                "behavior one" if cid == "B-PARSER-001" else cid
                for cid in unit.get("classificationIds", [])
            ]
        self.assert_invalid(manifest, classification, "not Missions-safe")

    def test_rejects_migration_id_outside_the_missions_safe_charset(self):
        manifest = valid_manifest()
        classification = valid_classification()
        manifest["migrationId"] = "MIG 001"
        classification["migrationId"] = "MIG 001"
        self.assert_invalid(manifest, classification, "not Missions-safe")

    def test_rejects_migration_id_mismatch(self):
        classification = valid_classification()
        classification["migrationId"] = "MIG-OTHER"
        self.assert_invalid(valid_manifest(), classification, "migration IDs differ")

    def test_rejects_source_revision_mismatch(self):
        classification = valid_classification()
        classification["referenceRevision"] = "git:def"
        self.assert_invalid(valid_manifest(), classification, "source revision does not match")

    def test_rejects_missing_and_self_dependencies(self):
        for dependency, message in (
            ("U-MISSING", "unresolved dependency 'U-MISSING'"),
            ("U-LEXER", "self dependency"),
        ):
            with self.subTest(dependency=dependency):
                manifest = valid_manifest()
                manifest["units"][1]["dependencies"] = [dependency]
                self.assert_invalid(manifest, valid_classification(), message)

    def test_rejects_dependency_cycles_that_were_not_collapsed_to_an_scc_unit(self):
        manifest = valid_manifest()
        manifest["units"][0]["dependencies"] = ["U-LEXER"]
        self.assert_invalid(manifest, valid_classification(), "dependency cycle")
        self.assert_invalid(manifest, valid_classification(), "explicit scc unit")

    def test_rejects_unresolved_classification_ids(self):
        manifest = valid_manifest()
        manifest["units"][0]["classificationIds"] = ["B-MISSING"]
        self.assert_invalid(manifest, valid_classification(), "unresolved classification ID 'B-MISSING'")

    def test_rejects_noncanonical_paths(self):
        for path in (
            ".",
            "/legacy/src/parser.c",
            "legacy/src/../src/parser.c",
            "legacy\\src\\parser.c",
            "legacy/src/parser.c\x00suffix",
            "legacy/src/parser.c\x85suffix",
        ):
            with self.subTest(path=path):
                manifest = valid_manifest()
                manifest["units"][0]["sourcePaths"] = [path]
                self.assert_invalid(manifest, valid_classification(), "canonical relative path")

    def test_accepts_workspace_root_with_disjoint_physical_scopes(self):
        manifest = valid_manifest()
        manifest["source"]["root"] = "."
        manifest["target"]["root"] = "."
        manifest["scope"] = {
            "source": {"includes": ["src/legacy"], "excludes": []},
            "target": {"includes": ["apps", "packages"], "excludes": []},
            "externalConsumers": [],
        }
        manifest["units"][0]["sourcePaths"] = ["src/legacy/parser.c"]
        manifest["units"][0]["targetPaths"] = ["apps/parser.ts"]
        manifest["units"][1]["sourcePaths"] = ["src/legacy/lexer.c"]
        manifest["units"][1]["targetPaths"] = ["packages/lexer.ts"]
        result = self.run_validator(manifest, valid_classification())
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_rejects_windows_drive_qualified_paths(self):
        manifest = valid_manifest()
        manifest["target"]["root"] = "C:/repo/target"
        self.assert_invalid(manifest, valid_classification(), "canonical relative path")

    def test_rejects_scope_paths_outside_source_and_target_roots(self):
        for field in ("includes", "excludes"):
            with self.subTest(field=field):
                manifest = valid_manifest()
                manifest["scope"]["source"][field] = ["secrets"]
                self.assert_invalid(
                    manifest,
                    valid_classification(),
                    "not contained by source root 'legacy'",
                )

    def test_rejects_unit_paths_outside_roots_or_declared_scope(self):
        cases = (
            ("sourcePaths", "other/parser.c", "source root 'legacy'"),
            ("targetPaths", "other/parser.rs", "target root 'target'"),
            ("sourcePaths", "legacy/test/parser.c", "outside source scope includes"),
            ("targetPaths", "target/test/parser.rs", "outside target scope includes"),
            ("sourcePaths", "legacy/src/generated/parser.c", "excluded from source scope"),
            ("targetPaths", "target/src/generated/parser.rs", "excluded from target scope"),
        )
        for field, path, message in cases:
            with self.subTest(field=field, path=path):
                manifest = valid_manifest()
                manifest["scope"]["source"]["excludes"] = ["legacy/src/generated"]
                manifest["scope"]["target"]["excludes"] = ["target/src/generated"]
                manifest["units"][0][field] = [path]
                self.assert_invalid(manifest, valid_classification(), message)

    def test_accepts_support_unit_without_a_behavior_when_statically_blocked(self):
        manifest = valid_manifest()
        manifest["units"][1]["classificationIds"] = []
        manifest["units"][1]["blockedBy"] = ["package contract pending"]
        classification = valid_classification()
        classification["behaviors"] = classification["behaviors"][:1]
        result = self.run_validator(manifest, classification)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_accepts_unit_marked_excluded_with_a_decision_reference(self):
        manifest = valid_manifest()
        manifest["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
        rulebook = "# Rulebook\n\n### rulebook@5 (2026-07-30) -- fixture decision\n"
        result = self.run_validator(manifest, valid_classification(), rulebook)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_rejects_excluded_unit_without_a_decision_reference(self):
        manifest = valid_manifest()
        manifest["units"][1]["excluded"] = {}
        self.assert_invalid(manifest, valid_classification(), "decisionRef")

    def test_rejects_excluded_unit_with_a_malformed_decision_reference(self):
        manifest = valid_manifest()
        manifest["units"][1]["excluded"] = {"decisionRef": "rulebook@latest"}
        self.assert_invalid(manifest, valid_classification(), "decisionRef")

    def test_rejects_excluded_unit_without_rulebook_when_rulebook_argument_is_absent(self):
        manifest = valid_manifest()
        manifest["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
        result = self.run_validator(manifest, valid_classification())
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("no rulebook was provided", result.stderr)

    def test_rejects_excluded_unit_whose_decision_reference_does_not_exist_in_rulebook(self):
        manifest = valid_manifest()
        manifest["units"][1]["excluded"] = {"decisionRef": "rulebook@99"}
        rulebook = "# Rulebook\n\n### rulebook@5 (2026-07-30) -- fixture decision\n"
        result = self.run_validator(manifest, valid_classification(), rulebook)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("unknown rulebook revision rulebook@99", result.stderr)

    def test_rejects_excluded_unit_on_a_non_structure_preserving_route(self):
        manifest = valid_manifest()
        manifest["variant"] = "same-stack-uplift"
        manifest["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
        rulebook = "# Rulebook\n\n### rulebook@5 (2026-07-30) -- fixture decision\n"
        result = self.run_validator(manifest, valid_classification(), rulebook)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("only defined for the structure-preserving-port route", result.stderr)

    def test_rejects_active_unit_depending_on_an_excluded_unit(self):
        manifest = valid_manifest()
        manifest["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
        manifest["units"][0]["dependencies"] = ["U-LEXER"]
        rulebook = "# Rulebook\n\n### rulebook@5 (2026-07-30) -- fixture decision\n"
        result = self.run_validator(manifest, valid_classification(), rulebook)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("unit 'U-PARSER' depends on excluded unit 'U-LEXER'", result.stderr)

    def test_accepts_excluded_unit_depending_on_active_prerequisites(self):
        manifest = valid_manifest()
        manifest["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
        rulebook = "# Rulebook\n\n### rulebook@5 (2026-07-30) -- fixture decision\n"
        result = self.run_validator(manifest, valid_classification(), rulebook)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_rejects_unit_declaring_both_excluded_and_blocked_by(self):
        manifest = valid_manifest()
        manifest["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
        manifest["units"][1]["blockedBy"] = ["package contract pending"]
        rulebook = "# Rulebook\n\n### rulebook@5 (2026-07-30) -- fixture decision\n"
        result = self.run_validator(manifest, valid_classification(), rulebook)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("declares both excluded and blockedBy", result.stderr)

    def test_rejects_unit_without_classification_ids_and_without_blocker(self):
        manifest = valid_manifest()
        manifest["units"][1]["classificationIds"] = []
        classification = valid_classification()
        classification["behaviors"] = classification["behaviors"][:1]
        self.assert_invalid(
            manifest,
            classification,
            "unit 'U-LEXER' without classification IDs must declare a static blocker",
        )

    def test_rejects_behavior_not_assigned_to_a_migration_unit(self):
        manifest = valid_manifest()
        manifest["units"][1]["classificationIds"] = ["B-PARSER-001"]
        self.assert_invalid(
            manifest,
            valid_classification(),
            "behavior 'B-LEXER-001' is not assigned to a migration unit",
        )

    def test_rejects_path_overlap_within_each_system_namespace(self):
        cases = (
            ("sourcePaths", "sourcePaths", "legacy/src"),
            ("targetPaths", "targetPaths", "target/src"),
        )
        for left_field, right_field, path in cases:
            with self.subTest(left_field=left_field, right_field=right_field):
                manifest = valid_manifest()
                manifest["units"][0][left_field] = [path]
                manifest["units"][1][right_field] = [f"{path}/nested"]
                self.assert_invalid(manifest, valid_classification(), "overlaps across units")

    def test_rejects_cross_system_path_overlap_in_one_checkout(self):
        manifest = valid_manifest()
        manifest["source"]["root"] = "repo"
        manifest["target"]["root"] = "repo/ported"
        manifest["scope"] = {
            "source": {"includes": ["repo"], "excludes": []},
            "target": {
                "includes": ["repo/ported"],
                "excludes": ["repo/ported/generated"],
            },
            "externalConsumers": [],
        }
        manifest["units"][0]["sourcePaths"] = ["repo/ported/pkg"]
        manifest["units"][0]["targetPaths"] = ["repo/ported/parser.rs"]
        manifest["units"][1]["sourcePaths"] = ["repo/legacy/lexer.c"]
        manifest["units"][1]["targetPaths"] = ["repo/ported/pkg/generated"]
        self.assert_invalid(manifest, valid_classification(), "overlaps across units")

    def test_rejects_unknown_disposition_blocking_after_batch(self):
        classification = valid_classification()
        classification["behaviors"][0]["disposition"] = "unknown"
        classification["behaviors"][0]["blockingStage"] = "release"
        self.assert_invalid(
            valid_manifest(),
            classification,
            "'batch' was expected",
        )

    def test_rejects_whitespace_only_decision_owner(self):
        classification = valid_classification()
        classification["behaviors"][0]["decisionOwner"] = " \t"
        self.assert_invalid(valid_manifest(), classification, "decisionOwner")

    def test_reports_schema_errors_before_semantic_checks(self):
        classification = valid_classification()
        classification["behaviors"][0]["blockingStage"] = "wave"
        result = self.run_validator(valid_manifest(), classification)
        self.assertEqual(1, result.returncode)
        self.assertIn("schema error", result.stderr)
        self.assertIn("blockingStage", result.stderr)


if __name__ == "__main__":
    unittest.main()
