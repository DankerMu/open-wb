from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import importlib.util
import unittest
from unittest.mock import patch
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
BUILDER = SKILL_ROOT / "tools" / "build_missions_v4_pack.py"
MISSIONS_ROOT = SKILL_ROOT.parents[1] / "_archived" / "missions"
MISSIONS_CLI = MISSIONS_ROOT / "src" / "missions-cli.ts"
BUILDER_SPEC = importlib.util.spec_from_file_location("build_missions_v4_pack", BUILDER)
assert BUILDER_SPEC is not None and BUILDER_SPEC.loader is not None
BUILDER_MODULE = importlib.util.module_from_spec(BUILDER_SPEC)
sys.path.insert(0, str(SKILL_ROOT / "tools"))
BUILDER_SPEC.loader.exec_module(BUILDER_MODULE)


def digest(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def approval_subject(plan: dict) -> dict:
    subject = {key: value for key, value in plan.items() if key != "contentDigest"}
    approval_ref = plan["approval"]["approvalArtifactRef"]
    subject["artifacts"] = [
        {"kind": artifact["kind"], "artifactRef": artifact["artifactRef"]}
        if artifact["artifactRef"] == approval_ref
        else artifact
        for artifact in plan["artifacts"]
    ]
    return subject


def write_json(path: Path, value: object) -> str:
    content = f"{json.dumps(value, indent=2)}\n".encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return digest(content)


def write_text(path: Path, value: str) -> str:
    content = value.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return digest(content)


def manifest() -> dict:
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


def classification() -> dict:
    def behavior(identifier: str, citation: str) -> dict:
        return {
            "id": identifier,
            "statement": f"Observable behavior {identifier} is preserved.",
            "sourceCitations": [citation],
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
        "behaviors": [
            behavior("B-PARSER-001", "legacy/src/parser.c:42"),
            behavior("B-LEXER-001", "legacy/src/lexer.c:42"),
        ],
    }


def isolated_git_environment() -> dict[str, str]:
    environment = dict(os.environ)
    for name in (
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    ):
        environment.pop(name, None)
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    return environment


def create_repository(base: Path) -> tuple[Path, str, str]:
    repository = base / "repository"
    repository.mkdir(parents=True, exist_ok=True)
    environment = isolated_git_environment()
    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "fixture@example.test"],
        ["git", "config", "user.name", "Fixture"],
    ):
        subprocess.run(command, cwd=repository, env=environment, check=True, capture_output=True)
    (repository / "README.md").write_text("# migration fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repository, env=environment, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repository, env=environment, check=True, capture_output=True)
    baseline = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repository, env=environment, check=True, text=True, capture_output=True
    ).stdout.strip()
    return repository, str(repository.resolve()), baseline


def create_program(base: Path, repository: Path | None = None) -> Path:
    program = base / "migration"
    program.mkdir(parents=True)
    manifest_digest = write_json(program / "manifest.json", manifest())
    classification_digest = write_json(program / "source-classification.json", classification())
    route_digest = write_text(program / "RULEBOOK.md", "# Rulebook\n\n### rulebook@5 (2026-07-30) -- fixture decision\n\nPreserve parser behavior.\n")
    gap_inventory_digest = write_text(program / "gap-inventory.tsv", "unit\tstatus\nU-PARSER\tcovered\n")
    vdd_digest = write_json(
        program / "vdd" / "binding.json",
        {"contractId": "VDD-MIG-001", "claimIds": ["C-B-PARSER-001", "C-B-LEXER-001"]},
    )
    playbook_digest = write_text(program / "PILOT_PLAYBOOK.md", "# Pilot\n\nRun the qualified judge first.\n")
    skill_digest = write_text(program / "skills" / "parser-worker" / "SKILL.md", "# Parser worker\n")
    skill_reference_digest = write_text(
        program / "skills" / "parser-worker" / "references" / "rules.md", "# Parser rules\n"
    )
    qa_digest = write_text(program / "qa" / "parser-flow.md", "# Parser QA flow\n")
    units = [
        {
            "id": "U-PARSER",
            "skillName": "parser-worker",
            "skillFiles": [
                {"artifactRef": "skills/parser-worker/SKILL.md", "digest": skill_digest},
                {"artifactRef": "skills/parser-worker/references/rules.md", "digest": skill_reference_digest},
            ],
            "verification": {
                "mode": "steps",
                "steps": [{"id": "parser-tests", "command": "python3 -m unittest", "expectedExit": "zero"}],
            },
            "qaFlows": [
                {
                    "id": "parser-flow",
                    "artifact": {"artifactRef": "qa/parser-flow.md", "digest": qa_digest},
                    "passCriteria": [{"id": "parser-result", "text": "The parser result is correct."}],
                }
            ],
        },
        {
            "id": "U-LEXER",
            "skillName": None,
            "skillFiles": [],
            "verification": {
                "mode": "steps",
                "steps": [{"id": "lexer-tests", "command": "python3 -m unittest", "expectedExit": "zero"}],
            },
            "qaFlows": [],
        },
    ]
    plan = {
        "id": "migration-pilot-001",
        "revision": 1,
        "phase": "pilot",
        "milestone": "pilot",
        "units": units,
        "budgets": {"maxAttemptsPerFeature": 3, "maxRepairRoundsPerMilestone": 2},
        "reviewPolicy": {
            "scrutiny": "required",
            "checklist": [{"id": "migration-scope", "text": "Review the approved migration scope and VDD binding."}],
        },
    }
    known_good = {"id": "known-good-pass", "command": "python3 -c \"raise SystemExit(0)\"", "expectedExit": "zero"}
    known_bad = {"id": "known-bad-rejected", "command": "python3 -c \"raise SystemExit(1)\"", "expectedExit": "nonzero"}
    restoration = {"id": "restoration-pass", "command": "python3 -c \"raise SystemExit(0)\"", "expectedExit": "zero"}
    if repository is None:
        repository, canonical_repository, baseline = create_repository(base)
    else:
        canonical_repository = str(repository.resolve())
        baseline = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repository, env=isolated_git_environment(), check=True, text=True, capture_output=True
        ).stdout.strip()
    repository_binding = {"canonicalRealPath": canonical_repository, "baselineCommit": baseline}
    route_artifacts = {
        "rulebook": {"artifactRef": "RULEBOOK.md", "digest": route_digest},
        "gapInventory": {"artifactRef": "gap-inventory.tsv", "digest": gap_inventory_digest},
    }
    g1 = {
        "schemaVersion": "code-migration.g1-judge-qualification.v2",
        "migrationId": "MIG-001",
        "verdict": "qualified",
        "qualifiedBy": "vdd-owner",
        "qualifiedAt": "2026-07-17T00:00:00Z",
        "repository": repository_binding,
        "manifestDigest": manifest_digest,
        "sourceClassificationDigest": classification_digest,
        "routeArtifacts": route_artifacts,
        "vddBindingDigest": vdd_digest,
        "knownGood": known_good,
        "knownBad": known_bad,
        "restoration": restoration,
    }
    g1_digest = write_json(program / "evidence" / "g1-judge.json", g1)
    g2 = {
        "schemaVersion": "code-migration.g2-plan-approval.v2",
        "migrationId": "MIG-001",
        "decision": "approved",
        "approvedBy": "contract-owner",
        "approvedAt": "2026-07-18T00:00:00Z",
        "g1JudgeQualificationDigest": g1_digest,
        "repository": repository_binding,
        "manifestDigest": manifest_digest,
        "sourceClassificationDigest": classification_digest,
        "routeArtifacts": route_artifacts,
        "vddBindingDigest": vdd_digest,
        "pilotPlaybookDigest": playbook_digest,
        "plan": plan,
    }
    g2_digest = write_json(program / "approval" / "g2-plan.json", g2)
    request = {
        "schemaVersion": "code-migration-missions-v4-2",
        "migrationId": "MIG-001",
        "repository": repository_binding,
        "plan": plan,
        "g1JudgeQualification": {
            "artifact": {"artifactRef": "evidence/g1-judge.json", "digest": g1_digest},
            "knownGood": known_good,
            "knownBad": known_bad,
            "restoration": restoration,
        },
        "g2Approval": {
            "artifact": {"artifactRef": "approval/g2-plan.json", "digest": g2_digest},
            "approvedBy": "contract-owner",
            "approvedAt": "2026-07-18T00:00:00Z",
        },
        "migrationArtifacts": {
            "manifest": {"artifactRef": "manifest.json", "digest": manifest_digest},
            "sourceClassification": {"artifactRef": "source-classification.json", "digest": classification_digest},
            "routeArtifacts": route_artifacts,
            "vddBinding": {"artifactRef": "vdd/binding.json", "digest": vdd_digest},
            "pilotPlaybook": {"artifactRef": "PILOT_PLAYBOOK.md", "digest": playbook_digest},
        },
    }
    write_json(program / "missions-v4-pack-request.json", request)
    return program


def refresh_gate_bindings(program: Path) -> None:
    request_path = program / "missions-v4-pack-request.json"
    request = json.loads(request_path.read_text(encoding="utf-8"))
    manifest_digest = digest((program / "manifest.json").read_bytes())
    classification_digest = digest((program / "source-classification.json").read_bytes())
    route_artifacts = request["migrationArtifacts"]["routeArtifacts"]
    for artifact in route_artifacts.values():
        artifact["digest"] = digest((program / artifact["artifactRef"]).read_bytes())
    vdd_digest = digest((program / "vdd" / "binding.json").read_bytes())
    playbook_digest = digest((program / "PILOT_PLAYBOOK.md").read_bytes())
    request["migrationArtifacts"]["manifest"]["digest"] = manifest_digest
    request["migrationArtifacts"]["sourceClassification"]["digest"] = classification_digest
    request["migrationArtifacts"]["vddBinding"]["digest"] = vdd_digest
    request["migrationArtifacts"]["pilotPlaybook"]["digest"] = playbook_digest
    route_artifacts = request["migrationArtifacts"]["routeArtifacts"]
    shared = {
        "migrationId": request["migrationId"],
        "repository": request["repository"],
        "manifestDigest": manifest_digest,
        "sourceClassificationDigest": classification_digest,
        "routeArtifacts": route_artifacts,
        "vddBindingDigest": vdd_digest,
    }
    g1_path = program / "evidence" / "g1-judge.json"
    g1 = json.loads(g1_path.read_text(encoding="utf-8"))
    g1.update(shared)
    g1["knownGood"] = request["g1JudgeQualification"]["knownGood"]
    g1["knownBad"] = request["g1JudgeQualification"]["knownBad"]
    g1["restoration"] = request["g1JudgeQualification"]["restoration"]
    g1_digest = write_json(g1_path, g1)
    request["g1JudgeQualification"]["artifact"]["digest"] = g1_digest
    g2_path = program / "approval" / "g2-plan.json"
    g2 = json.loads(g2_path.read_text(encoding="utf-8"))
    g2.update(shared)
    g2["g1JudgeQualificationDigest"] = g1_digest
    g2["pilotPlaybookDigest"] = playbook_digest
    g2["plan"] = request["plan"]
    g2["approvedBy"] = request["g2Approval"]["approvedBy"]
    g2["approvedAt"] = request["g2Approval"]["approvedAt"]
    g2_digest = write_json(g2_path, g2)
    request["g2Approval"]["artifact"]["digest"] = g2_digest
    write_json(request_path, request)


def mutate_request(program: Path, mutate) -> None:
    path = program / "missions-v4-pack-request.json"
    request = json.loads(path.read_text(encoding="utf-8"))
    mutate(request)
    write_json(path, request)


def change_request_plan_revision(program: Path) -> None:
    mutate_request(program, lambda request: request["plan"].update({"revision": 2}))


def change_request_known_bad_command(program: Path) -> None:
    mutate_request(
        program,
        lambda request: request["g1JudgeQualification"]["knownBad"].update({"command": "different-command"}),
    )


def set_manifest_unit_id(program: Path, identifier: str) -> None:
    path = program / "manifest.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    previous = document["units"][0]["id"]
    document["units"][0]["id"] = identifier
    document["units"][1]["dependencies"] = [identifier if value == previous else value for value in document["units"][1]["dependencies"]]
    write_json(path, document)
    def update_plan(request: dict) -> None:
        request["plan"]["units"][0]["id"] = identifier

    mutate_request(program, update_plan)
    refresh_gate_bindings(program)


def duplicate_manifest_value(program: Path, field: str) -> None:
    path = program / "manifest.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["units"][0][field].append(document["units"][0][field][0])
    write_json(path, document)
    refresh_gate_bindings(program)


def overlap_manifest_target_paths(program: Path) -> None:
    path = program / "manifest.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["units"][0]["targetPaths"] = ["target/src/parser.rs", "target/src/parser.rs/nested"]
    write_json(path, document)
    refresh_gate_bindings(program)


def duplicate_request_checklist_id(program: Path) -> None:
    def mutate(request: dict) -> None:
        request["plan"]["reviewPolicy"]["checklist"].append(
            {"id": "migration-scope", "text": "Duplicate review obligation."}
        )

    mutate_request(program, mutate)
    refresh_gate_bindings(program)


def make_generated_plan_over_limit(program: Path) -> None:
    classification_path = program / "source-classification.json"
    classification_document = json.loads(classification_path.read_text(encoding="utf-8"))
    classification_document["behaviors"][0]["statement"] = "x" * (4 * 1024 * 1024 + 256 * 1024)
    write_json(classification_path, classification_document)

    manifest_path = program / "manifest.json"
    manifest_document = json.loads(manifest_path.read_text(encoding="utf-8"))
    duplicate_unit = dict(manifest_document["units"][0])
    duplicate_unit.update({"id": "U-REPLAY", "sourcePaths": ["legacy/src/replay.c"], "targetPaths": ["target/src/replay.rs"], "dependencies": []})
    manifest_document["units"].append(duplicate_unit)
    write_json(manifest_path, manifest_document)

    def mutate(request: dict) -> None:
        duplicate_obligation = dict(request["plan"]["units"][0])
        duplicate_obligation.update({"id": "U-REPLAY", "skillName": None, "skillFiles": [], "qaFlows": []})
        request["plan"]["units"].append(duplicate_obligation)

    mutate_request(program, mutate)
    refresh_gate_bindings(program)


class MissionsV4PackProducerTests(unittest.TestCase):
    def run_builder(self, program: Path, output: Path, repository: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(BUILDER), "--program", str(program), "--output", str(output), "--repository", str(repository)],
            cwd=SKILL_ROOT,
            env=isolated_git_environment(),
            text=True,
            capture_output=True,
            check=False,
        )

    def test_generated_pack_validates_and_admits_with_a_derived_handoff_index(self):
        self.assertIsNotNone(shutil.which("bun"), "Bun is required for the VAL-006 public source-CLI regression")
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, canonical_repository, baseline = create_repository(base)
            program = create_program(base, repository)
            output = base / "pack"

            build = self.run_builder(program, output, repository)
            self.assertEqual(0, build.returncode, build.stdout + build.stderr)
            result = json.loads(build.stdout)
            self.assertEqual("missions", result["schemaVersion"])
            self.assertEqual(str(output), result["packPath"])

            plan = json.loads((output / "approved-plan.json").read_text(encoding="utf-8"))
            self.assertEqual(canonical_repository, plan["repository"]["canonicalRealPath"])
            self.assertEqual(baseline, plan["repository"]["baselineCommit"])
            self.assertEqual(["judge-qualification", "U-PARSER", "U-LEXER"], [feature["id"] for feature in plan["features"]])
            self.assertEqual(["judge-qualification"], plan["features"][1]["dependsOn"])
            self.assertEqual(["judge-qualification", "U-PARSER"], plan["features"][2]["dependsOn"])
            self.assertEqual("parser-worker", plan["features"][1]["skillName"])
            self.assertEqual("steps", plan["features"][1]["verification"]["mode"])
            self.assertEqual("parser-flow", plan["features"][1]["qaFlows"][0]["id"])
            self.assertEqual("steps", plan["features"][2]["verification"]["mode"])
            self.assertTrue((output / "skills" / "parser-worker" / "SKILL.md").is_file())
            self.assertTrue((output / "skills" / "parser-worker" / "references" / "rules.md").is_file())
            self.assertTrue((output / "qa" / "parser-flow.md").is_file())
            self.assertTrue((output / "approval" / "execution-approval.json").is_file())
            self.assertTrue((output / "context" / "g2-plan-approval.json").is_file())
            self.assertTrue((output / "context" / "migration-manifest.json").is_file())
            self.assertTrue((output / "context" / "source-classification.json").is_file())
            self.assertTrue((output / "context" / "rulebook.md").is_file())
            self.assertTrue((output / "context" / "gap-inventory.tsv").is_file())
            self.assertTrue((output / "context" / "vdd-binding.json").is_file())
            approval_envelope = json.loads((output / "approval" / "execution-approval.json").read_text(encoding="utf-8"))
            self.assertEqual("missions.approval.v1", approval_envelope["schemaVersion"])
            self.assertEqual(plan["approval"]["approvedBy"], approval_envelope["approvedBy"])
            self.assertEqual(plan["approval"]["approvedAt"], approval_envelope["approvedAt"])
            self.assertEqual(plan["planId"], approval_envelope["subject"]["planId"])
            self.assertEqual(plan["revision"], approval_envelope["subject"]["revision"])
            self.assertEqual(
                {"canonicalRealPath": plan["repository"]["canonicalRealPath"], "baselineCommit": plan["repository"]["baselineCommit"]},
                approval_envelope["subject"]["repository"],
            )
            self.assertEqual(digest(canonical(approval_subject(plan)).encode("utf-8")), approval_envelope["subject"]["subjectDigest"])
            placeholder_plan = json.loads(json.dumps(plan))
            placeholder_plan["artifacts"][0] = {
                "kind": "approval",
                "artifactRef": "approval/execution-approval.json",
                "digest": "sha256:" + "0" * 64,
                "byteLength": 0,
            }
            self.assertEqual(
                BUILDER_MODULE.approval_subject_digest(placeholder_plan),
                BUILDER_MODULE.approval_subject_digest(plan),
            )
            self.assertEqual(
                (program / "approval" / "g2-plan.json").read_bytes(),
                (output / "context" / "g2-plan-approval.json").read_bytes(),
            )
            declared = {artifact["artifactRef"]: artifact for artifact in plan["artifacts"]}
            self.assertEqual("approval", declared["approval/execution-approval.json"]["kind"])
            self.assertEqual(digest((output / "approval" / "execution-approval.json").read_bytes()), declared["approval/execution-approval.json"]["digest"])
            self.assertEqual("context", declared["context/g2-plan-approval.json"]["kind"])
            self.assertEqual(digest((output / "context" / "g2-plan-approval.json").read_bytes()), declared["context/g2-plan-approval.json"]["digest"])
            for feature in plan["features"]:
                self.assertIn("approval/execution-approval.json", feature["inputArtifacts"])
                self.assertIn("context/g2-plan-approval.json", feature["inputArtifacts"])
                self.assertIn("context/rulebook.md", feature["inputArtifacts"])
                self.assertIn("context/gap-inventory.tsv", feature["inputArtifacts"])
            self.assertTrue((output / "context" / "pilot-playbook.md").is_file())

            handoff = (output / "MISSION_HANDOFF.md").read_text(encoding="utf-8").lower()
            self.assertIn(plan["contentDigest"], handoff)
            for forbidden in ("queue", "lease", "retry", "worker identity", "mutable status", "next action"):
                self.assertIsNone(re.search(rf"\b{re.escape(forbidden)}\b", handoff))
            self.assertIsNotNone(re.search(r"\bmission\b", handoff))

            validate = subprocess.run(
                ["bun", str(MISSIONS_CLI), "validate-pack", "--plan", str(output / "approved-plan.json")],
                cwd=MISSIONS_ROOT,
                env=isolated_git_environment(),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, validate.returncode, validate.stdout + validate.stderr)
            self.assertTrue(json.loads(validate.stdout)["ok"])

            mission_root = base / "mission-root"
            admitted = subprocess.run(
                ["bun", str(MISSIONS_CLI), "admit", "--root", str(mission_root), "--plan", str(output / "approved-plan.json"), "--operation-id", "admit-pack"],
                cwd=MISSIONS_ROOT,
                env=isolated_git_environment(),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, admitted.returncode, admitted.stdout + admitted.stderr)
            self.assertTrue(json.loads(admitted.stdout)["ok"])

    def test_refuses_v1_requests_before_producing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            request_path = program / "missions-v4-pack-request.json"
            request = json.loads(request_path.read_text(encoding="utf-8"))
            request["schemaVersion"] = "code-migration-missions-v4-1"
            write_json(request_path, request)

            result = self.run_builder(program, base / "pack", repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("code-migration-missions-v4-2", result.stderr)

    def test_refuses_a_symlinked_pack_request_before_producing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            request_path = program / "missions-v4-pack-request.json"
            external_request = base / "external-request.json"
            request_path.replace(external_request)
            request_path.symlink_to(external_request)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("missions-v4-pack-request.json must be a regular non-symlink file", result.stderr)
            self.assertFalse(output.exists())

    def test_repository_inspection_ignores_hostile_local_core_worktree_config(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, canonical, baseline = create_repository(base)
            subprocess.run(
                ["git", "config", "core.worktree", str(base / "redirected-worktree")],
                cwd=repository,
                env=isolated_git_environment(),
                check=True,
                capture_output=True,
            )

            self.assertEqual(
                {"canonicalRealPath": canonical, "baselineCommit": baseline},
                BUILDER_MODULE.inspect_repository(repository),
            )

    def test_refuses_repository_bindings_that_do_not_match_the_target_worktree(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, baseline = create_repository(base)
            other_repository, other_canonical, _ = create_repository(base / "other")
            cases = (
                ("different-repository", lambda request: request.update({"repository": {"canonicalRealPath": other_canonical, "baselineCommit": baseline}})),
                ("different-baseline", lambda request: request["repository"].update({"baselineCommit": "f" * 40})),
            )
            for name, mutate in cases:
                with self.subTest(name=name):
                    program = create_program(base / name, repository)
                    mutate_request(program, mutate)
                    output = base / f"pack-{name}"

                    result = self.run_builder(program, output, repository)

                    self.assertEqual(1, result.returncode, result.stdout + result.stderr)
                    self.assertIn("repository binding does not match the target worktree", result.stderr)
                    self.assertFalse(output.exists())
            self.assertTrue(other_repository.is_dir())

    def test_refuses_pack_when_g1_or_g2_or_context_identity_is_missing_or_changed(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)

            cases = (
                ("missing-g1", lambda program, value: value.pop("g1JudgeQualification"), "g1JudgeQualification"),
                ("missing-g2", lambda program, value: value.pop("g2Approval"), "g2Approval"),
                (
                    "bad-g1-semantics",
                    lambda program, value: value["g1JudgeQualification"]["restoration"].update({"expectedExit": "nonzero"}),
                    "restoration step must expect zero exit",
                ),
                (
                    "changed-vdd-binding",
                    lambda program, value: (program / "vdd" / "binding.json").write_text("{}\n", encoding="utf-8"),
                    "VDD binding digest does not match source",
                ),
                (
                    "unknown-unit",
                    lambda program, value: value["plan"]["units"][0].update({"id": "U-MISSING"}),
                    "unknown migration units",
                ),
            )
            for name, mutate, message in cases:
                with self.subTest(name=name):
                    restore_program = create_program(base / name, repository)
                    current_path = restore_program / "missions-v4-pack-request.json"
                    current = json.loads(current_path.read_text(encoding="utf-8"))
                    mutate(restore_program, current)
                    write_json(current_path, current)
                    output = base / f"pack-{name}"
                    result = self.run_builder(restore_program, output, repository)
                    self.assertEqual(1, result.returncode, result.stdout + result.stderr)
                    self.assertIn(message, result.stderr)
                    self.assertFalse(output.exists())

    def test_accepts_g1_known_bad_step_with_aggregate_zero_semantics(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            request_path = program / "missions-v4-pack-request.json"
            request = json.loads(request_path.read_text(encoding="utf-8"))
            request["g1JudgeQualification"]["knownBad"]["command"] = "bash evidence/g1/requalification/run-known-bad.sh"
            request["g1JudgeQualification"]["knownBad"]["expectedExit"] = "zero"
            write_json(request_path, request)
            refresh_gate_bindings(program)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertTrue((output / "approval" / "execution-approval.json").is_file())

    def test_refuses_g2_approval_before_g1_qualification(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            g2_path = program / "approval" / "g2-plan.json"
            g2 = json.loads(g2_path.read_text(encoding="utf-8"))
            g2["approvedAt"] = "2026-07-16T00:00:00Z"
            write_json(g2_path, g2)
            request_path = program / "missions-v4-pack-request.json"
            request = json.loads(request_path.read_text(encoding="utf-8"))
            request["g2Approval"]["approvedAt"] = g2["approvedAt"]
            request["g2Approval"]["artifact"]["digest"] = digest(g2_path.read_bytes())
            write_json(request_path, request)
            output = base / "pack"
            result = self.run_builder(program, output, repository)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("G2 approval must not precede G1 qualification", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_stale_gate_bindings_and_unproducible_v4_feature_shapes(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            cases = (
                (
                    "stale-g2-plan",
                    change_request_plan_revision,
                    "G2 approval does not bind the current selected plan",
                ),
                (
                    "g1-command-mismatch",
                    change_request_known_bad_command,
                    "G1 judge qualification does not bind current knownBad step",
                ),
                (
                    "reserved-unit-id",
                    lambda program: set_manifest_unit_id(program, "judge-qualification"),
                    "reserved Feature ID judge-qualification",
                ),
                (
                    "current-validator-scrutiny-id",
                    lambda program: set_manifest_unit_id(program, "validator.pilot.scrutiny"),
                    "reserved Feature ID validator.pilot.scrutiny",
                ),
                (
                    "current-validator-user-testing-id",
                    lambda program: set_manifest_unit_id(program, "validator.pilot.user-testing"),
                    "reserved Feature ID validator.pilot.user-testing",
                ),
                (
                    "generic-validator-namespace",
                    lambda program: set_manifest_unit_id(program, "validator.future.custom"),
                    "reserved Feature ID validator.future.custom",
                ),
                (
                    "duplicate-target-path",
                    lambda program: duplicate_manifest_value(program, "targetPaths"),
                    "duplicate target paths",
                ),
                (
                    "overlapping-target-path",
                    overlap_manifest_target_paths,
                    "overlapping target paths",
                ),
                (
                    "duplicate-checklist-id",
                    lambda program: duplicate_request_checklist_id(program),
                    "reviewPolicy.checklist IDs contains duplicates",
                ),
            )
            for name, mutate, message in cases:
                with self.subTest(name=name):
                    program = create_program(base / name, repository)
                    mutate(program)
                    output = base / f"pack-{name}"
                    result = self.run_builder(program, output, repository)
                    self.assertEqual(1, result.returncode, result.stdout + result.stderr)
                    self.assertIn(message, result.stderr)
                    self.assertFalse(output.exists())

    def test_refuses_selected_unit_with_a_static_blocker(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            manifest_path = program / "manifest.json"
            document = json.loads(manifest_path.read_text(encoding="utf-8"))
            document["units"][0]["blockedBy"] = ["issue-43-body-digest"]
            write_json(manifest_path, document)
            refresh_gate_bindings(program)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("migration unit U-PARSER is blocked by: issue-43-body-digest", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_selected_unit_marked_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            manifest_path = program / "manifest.json"
            document = json.loads(manifest_path.read_text(encoding="utf-8"))
            document["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
            write_json(manifest_path, document)
            refresh_gate_bindings(program)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("migration unit U-LEXER is excluded from migration/scheduling by rulebook@5 and cannot be scheduled", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_selected_unit_marked_excluded_that_active_units_depend_on(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            manifest_path = program / "manifest.json"
            document = json.loads(manifest_path.read_text(encoding="utf-8"))
            document["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
            document["units"][1]["dependencies"] = []
            document["units"][0]["dependencies"] = ["U-LEXER"]
            write_json(manifest_path, document)
            refresh_gate_bindings(program)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("unit 'U-PARSER' depends on excluded unit 'U-LEXER'", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_excluded_unit_that_also_declares_a_static_blocker(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            manifest_path = program / "manifest.json"
            document = json.loads(manifest_path.read_text(encoding="utf-8"))
            document["units"][1]["blockedBy"] = ["issue-43-body-digest"]
            document["units"][1]["excluded"] = {"decisionRef": "rulebook@5"}
            write_json(manifest_path, document)
            refresh_gate_bindings(program)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("declares both excluded and blockedBy", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_excluded_unit_referencing_an_unknown_rulebook_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            manifest_path = program / "manifest.json"
            document = json.loads(manifest_path.read_text(encoding="utf-8"))
            document["units"][1]["excluded"] = {"decisionRef": "rulebook@99"}
            write_json(manifest_path, document)
            refresh_gate_bindings(program)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("excluded by unknown rulebook revision rulebook@99", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_missing_or_mismatched_unit_obligations(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            cases = (
                ("duplicate-unit", lambda request: request["plan"]["units"].append(request["plan"]["units"][0]), "contains duplicates"),
                ("missing-skill-md", lambda request: request["plan"]["units"][0]["skillFiles"].pop(0), "must declare skills/parser-worker/SKILL.md"),
                ("skill-path-mismatch", lambda request: request["plan"]["units"][0]["skillFiles"][1].update({"artifactRef": "skills/other/rules.md"}), "must stay under skills/parser-worker/"),
                ("none-verification", lambda request: request["plan"]["units"][0].update({"verification": {"mode": "none", "steps": []}}), "'steps' was expected"),
                ("missing-qa-file", lambda request: request["plan"]["units"][0]["qaFlows"][0]["artifact"].update({"artifactRef": "qa/missing.md"}), "cannot read unit U-PARSER QA flow parser-flow"),
                ("qa-namespace", lambda request: request["plan"]["units"][0]["qaFlows"][0]["artifact"].update({"artifactRef": "context/parser-flow.md"}), "does not match '^qa/'"),
                ("duplicate-qa-id", lambda request: request["plan"]["units"][1].update({"qaFlows": [request["plan"]["units"][0]["qaFlows"][0]]}), "plan.units QA flow IDs contains duplicates"),
            )
            for name, mutate, message in cases:
                with self.subTest(name=name):
                    program = create_program(base / name, repository)
                    mutate_request(program, mutate)
                    refresh_gate_bindings(program)
                    output = base / f"pack-{name}"
                    result = self.run_builder(program, output, repository)
                    self.assertEqual(1, result.returncode, result.stdout + result.stderr)
                    self.assertIn(message, result.stderr)
                    self.assertFalse(output.exists())

    def test_refuses_undeclared_file_in_selected_skill_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            write_text(program / "skills" / "parser-worker" / "extra.md", "undeclared\n")
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("must declare every regular file under skills/parser-worker/", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_more_than_the_maximum_declared_pack_artifacts_before_reading_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            request_path = program / "missions-v4-pack-request.json"
            request = json.loads(request_path.read_text(encoding="utf-8"))
            for index in range(BUILDER_MODULE.MAX_PROGRAM_ARTIFACTS):
                artifact = program / "skills" / "parser-worker" / "references" / f"count-{index}.txt"
                write_text(artifact, "x\\n")
                request["plan"]["units"][0]["skillFiles"].append(
                    {"artifactRef": artifact.relative_to(program).as_posix(), "digest": digest(artifact.read_bytes())}
                )
            write_json(request_path, request)
            refresh_gate_bindings(program)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("declares more than 4096 artifacts", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_pack_over_aggregate_32_mib_limit_before_materializing_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            request = json.loads((program / "missions-v4-pack-request.json").read_text(encoding="utf-8"))
            for index in range(5):
                path = program / "skills" / "parser-worker" / "references" / f"large-{index}.bin"
                path.write_bytes(bytes([index]) * (7 * 1024 * 1024))
                request["plan"]["units"][0]["skillFiles"].append(
                    {"artifactRef": f"skills/parser-worker/references/large-{index}.bin", "digest": digest(path.read_bytes())}
                )
            write_json(program / "missions-v4-pack-request.json", request)
            refresh_gate_bindings(program)
            request = json.loads((program / "missions-v4-pack-request.json").read_text(encoding="utf-8"))
            output = base / "pack"

            with patch.object(
                BUILDER_MODULE,
                "read_declared_file",
                wraps=BUILDER_MODULE.read_declared_file,
            ) as read_declared_file:
                with self.assertRaisesRegex(BUILDER_MODULE.PackRequestError, "aggregate 33554432 byte limit"):
                    BUILDER_MODULE.build_plan(program, manifest(), classification(), request)

            self.assertEqual([], read_declared_file.call_args_list)
            self.assertFalse(output.exists())

    def test_refuses_generated_plan_over_missions_8_mib_limit_before_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            make_generated_plan_over_limit(program)
            output = base / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("generated approved plan exceeds 8388608 byte limit", result.stderr)
            self.assertFalse(output.exists())

    def test_aggregate_limit_counts_generated_handoff_bytes(self):
        plan = {"planId": "p", "revision": 1, "contentDigest": "sha256:0", "approval": {"approvedBy": "owner", "approvedAt": "2026-07-18T00:00:00Z"}, "artifacts": []}
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository = base / "repository"
            repository.mkdir()
            output = base / "pack"
            plan_bytes = len(json.dumps(plan, ensure_ascii=False, indent=2).encode("utf-8")) + 1
            handoff_bytes = len(BUILDER_MODULE.render_handoff(output, plan).encode("utf-8"))
            filler = b"x" * (32 * 1024 * 1024 - plan_bytes - handoff_bytes + 1)
            with self.assertRaisesRegex(BUILDER_MODULE.PackRequestError, "aggregate 33554432 byte limit"):
                BUILDER_MODULE.write_pack(output, repository, plan, [("context/filler.bin", filler)])

    def test_output_parent_swap_is_rejected_before_publication(self):
        plan = {"planId": "p", "revision": 1, "contentDigest": "sha256:0", "approval": {"approvedBy": "owner", "approvedAt": "2026-07-18T00:00:00Z"}, "artifacts": []}
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository = base / "repository"
            repository.mkdir()
            output = base / "output-parent" / "pack"
            output.parent.mkdir()
            with patch.object(BUILDER_MODULE, "same_directory", return_value=False):
                with self.assertRaisesRegex(BUILDER_MODULE.PackRequestError, "output parent changed while producing the pack"):
                    BUILDER_MODULE.write_pack(output, repository, plan, [])
            self.assertFalse(output.exists())
            self.assertEqual([], list(output.parent.iterdir()))

    def test_output_staging_replacement_is_not_published_or_removed(self):
        plan = {"planId": "p", "revision": 1, "contentDigest": "sha256:0", "approval": {"approvedBy": "owner", "approvedAt": "2026-07-18T00:00:00Z"}, "artifacts": []}
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository = base / "repository"
            repository.mkdir()
            output = base / "pack"
            replacement = base / "replacement"
            replacement.mkdir()
            (replacement / "preserve.txt").write_text("preserve\n", encoding="utf-8")
            original_stat = BUILDER_MODULE.os.fsync
            swapped = False

            def swap_after_staging_sync(descriptor: int) -> int:
                nonlocal swapped
                if not swapped:
                    swapped = True
                    staging = next(output.parent.glob(f".{output.name}.tmp-*"))
                    staging.rename(base / "displaced-staging")
                    replacement.rename(staging)
                return original_stat(descriptor)

            with patch.object(BUILDER_MODULE.os, "fsync", side_effect=swap_after_staging_sync):
                with self.assertRaisesRegex(BUILDER_MODULE.PackRequestError, "temporary output pack changed"):
                    BUILDER_MODULE.write_pack(output, repository, plan, [])

            self.assertTrue(swapped)
            self.assertFalse(output.exists())
            staging = next(output.parent.glob(f".{output.name}.tmp-*"))
            self.assertEqual("preserve\n", (staging / "preserve.txt").read_text(encoding="utf-8"))

    def test_refuses_output_path_traversing_a_symlink_ancestor(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            real_parent = base / "real-output"
            real_parent.mkdir()
            alias_parent = base / "alias-output"
            alias_parent.symlink_to(real_parent, target_is_directory=True)
            output = alias_parent / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("output path must not traverse a symlink", result.stderr)
            self.assertFalse((real_parent / "pack").exists())

    def test_refuses_an_output_pack_inside_the_target_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            output = repository / "control" / "pack"

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("output pack must be outside the target repository", result.stderr)
            self.assertFalse(output.exists())

    def test_refuses_existing_output_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, _, _ = create_repository(base)
            program = create_program(base, repository)
            output = base / "pack"
            output.mkdir()
            marker = output / "user-work.txt"
            marker.write_text("preserve\n", encoding="utf-8")

            result = self.run_builder(program, output, repository)

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("output pack path already exists", result.stderr)
            self.assertEqual("preserve\n", marker.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
