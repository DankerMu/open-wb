from __future__ import annotations

import copy
import errno
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
SPEC = importlib.util.spec_from_file_location("vdd_accept", TOOLS / "vdd_accept.py")
assert SPEC and SPEC.loader
vdd_accept = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = vdd_accept
SPEC.loader.exec_module(vdd_accept)


def load(relative: str):
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


class AcceptanceControlPlaneTests(unittest.TestCase):
    def test_control_plane_sandbox_provider_uses_trusted_system_search_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            temp_root = root / "temp"
            temp_root.mkdir()

            def trusted_which(name, *, path=None):
                self.assertEqual(os.defpath, path)
                self.assertEqual("sandbox-exec", name)
                return "/usr/bin/sandbox-exec"

            with mock.patch.object(
                vdd_accept.sys,
                "platform",
                "darwin",
            ), mock.patch.object(
                vdd_accept.shutil,
                "which",
                side_effect=trusted_which,
            ), mock.patch.object(
                vdd_accept,
                "_runtime_read_roots",
                return_value=[],
            ):
                command = vdd_accept._sandbox_command(
                    [sys.executable],
                    workspace=workspace,
                    readable_files=[],
                    readable_dirs=[],
                    writable_files=[],
                    writable_dirs=[],
                    temp_root=temp_root,
                )
            self.assertEqual("/usr/bin/sandbox-exec", command[0])

    def test_control_plane_dependency_traversal_checks_deadline_without_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "nested").mkdir()
            with mock.patch.object(
                vdd_accept.time,
                "monotonic",
                side_effect=[0, 0, 6],
            ):
                with self.assertRaisesRegex(ValueError, "timed out during sandbox startup"):
                    vdd_accept._macos_dynamic_dependencies(
                        {Path(tmp)},
                        deadline=5,
                    )

    def test_control_plane_dependency_traversal_checks_deadline_inside_one_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "first.so").write_bytes(b"not-a-library")
            (root / "second.so").write_bytes(b"not-a-library")
            with mock.patch.object(
                vdd_accept.time,
                "monotonic",
                side_effect=[0, 0, 6],
            ):
                with self.assertRaisesRegex(ValueError, "timed out during sandbox startup"):
                    vdd_accept._macos_dynamic_dependencies(
                        {root},
                        deadline=5,
                    )

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS otool")
    def test_control_plane_batches_macos_runtime_dependency_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "first.bin"
            second = Path(tmp) / "second.bin"
            first.write_bytes(b"not-a-mach-o")
            second.write_bytes(b"not-a-mach-o")
            real_popen = subprocess.Popen
            probe_commands: list[list[str]] = []

            def counting_popen(*args, **kwargs):
                command = args[0]
                if isinstance(command, list) and command[:2] == ["otool", "-L"]:
                    probe_commands.append(command)
                return real_popen(*args, **kwargs)

            with mock.patch.object(
                vdd_accept.subprocess,
                "Popen",
                side_effect=counting_popen,
            ):
                vdd_accept._macos_dynamic_dependencies({first, second})
            self.assertEqual(1, len(probe_commands))

    def test_control_plane_runtime_dependency_probe_has_a_hard_deadline(self):
        process = mock.Mock()
        process.returncode = None
        with mock.patch.object(
            vdd_accept.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(
            vdd_accept,
            "_collect_bounded_step_output",
            side_effect=subprocess.TimeoutExpired(["otool"], 1),
        ), mock.patch.object(
            vdd_accept,
            "_terminate_owned_sandbox",
        ) as terminate:
            with self.assertRaisesRegex(ValueError, "dependency probe timed out"):
                vdd_accept._macos_dynamic_dependencies({Path(__file__)})
        terminate.assert_called_once_with(process)

    def test_control_plane_dependency_batch_keeps_valid_output_on_partial_failure(self):
        process = mock.Mock()
        process.returncode = 1
        process.poll.return_value = 1
        dependency = Path(sys.executable).resolve()
        output = f"\t{dependency} (compatibility version 1.0.0)\n".encode()
        with mock.patch.object(
            vdd_accept.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(
            vdd_accept,
            "_collect_bounded_step_output",
            side_effect=[(output, b"malformed peer"), (b"", b"")],
        ):
            observed = vdd_accept._macos_dynamic_dependencies({Path(__file__)})
        self.assertIn(dependency, observed)

    def make_case(self, workspace: Path):
        evidence = load("examples/light-construction/evidence.json")
        discovery_json = json.dumps(
            evidence["test_discovery"],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        runner = workspace / "runner.py"
        runner.write_text(
            "import pathlib, sys\n"
            f"DISCOVERY = {discovery_json!r}\n"
            "mode = sys.argv[1]\n"
            "if mode == 'discover':\n"
            "    pathlib.Path('discovery.json').write_text(DISCOVERY)\n"
            "elif mode == 'mutate-protected':\n"
            "    pathlib.Path('protected.txt').write_text('changed during acceptance\\n')\n"
            "elif mode == 'mutate-candidate':\n"
            "    pathlib.Path('candidate.txt').write_text('changed during acceptance\\n')\n"
            "elif mode == 'mark':\n"
            "    pathlib.Path('marker.txt').write_text('ran\\n')\n"
            "elif mode == 'bad':\n"
            "    print('A__B differs: a--b != a-b', file=sys.stderr)\n"
            "    raise SystemExit(1)\n"
            "raise SystemExit(1 if mode == 'crash-bad' else 0)\n",
            encoding="utf-8",
        )
        candidate = workspace / "candidate.txt"
        candidate.write_text("candidate\n", encoding="utf-8")
        protected = workspace / "protected.txt"
        protected.write_text("protected truth\n", encoding="utf-8")

        contract = load("examples/light-construction/contract.json")
        contract["baseline"]["semantic_red_command"] = "qualify bad"
        contract["gates"]["fast"] = "check candidate"
        contract["gates"]["focused"] = "check candidate"
        contract["gates"]["broad"] = "check candidate"
        contract["gates"]["integration"] = "check candidate"
        contract["gates"]["merge"] = "check candidate"
        contract["scope"]["editable"] = ["candidate.txt"]
        contract["candidate_capabilities"]["writable_paths"] = ["candidate.txt"]
        contract["candidate_capabilities"]["allowed_commands"] = [f"{sys.executable} runner.py"]
        contract["candidate_capabilities"]["readable_protected_paths"] = ["runner.py", "protected.txt"]
        contract["scope"]["protected"] = ["runner.py", "protected.txt"]
        contract["oracles"][0]["qualification"]["known_good_command"] = "qualify good"
        contract["oracles"][0]["qualification"]["restore_command"] = "qualify restore"
        contract["oracles"][0]["qualification"]["stability_command_ids"] = []
        contract["control_plane"] = {
            "candidate_artifacts": ["candidate.txt"],
            "protected_assets": [
                {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                },
                {
                    "path": "protected.txt",
                    "fingerprint": vdd_accept.file_fingerprint(protected),
                },
            ],
            "allowed_output_paths": ["discovery.json"],
            "environment_allowlist": ["PATH"],
            "discovery": {
                "command_id": "DISCOVERY",
                "result_path": "discovery.json",
                "producer_path": "runner.py",
            },
            "execution_plan": [
                {
                    "id": "GOOD",
                    "display": "qualify good",
                    "argv": [sys.executable, "runner.py", "good"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["good.log"],
                },
                {
                    "id": "BAD",
                    "display": "qualify bad",
                    "argv": [sys.executable, "runner.py", "bad"],
                    "expected_exit_code": 1,
                    "result": "expected_reject",
                    "write_paths": [],
                    "artifact_refs": ["D-REPEATED-SEPARATOR"],
                    "defeater_ids": ["D-REPEATED-SEPARATOR"],
                },
                {
                    "id": "RESTORE",
                    "display": "qualify restore",
                    "argv": [sys.executable, "runner.py", "restore"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["restore.log"],
                },
                {
                    "id": "DISCOVERY",
                    "display": "discover protected tests",
                    "argv": [sys.executable, "runner.py", "discover"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": ["discovery.json"],
                    "artifact_refs": ["discovery.json"],
                },
                {
                    "id": "CHECK",
                    "display": "check candidate",
                    "argv": [sys.executable, "runner.py", "check"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": ["focused.log"],
                    "claim_ids": ["C-SLUG"],
                    "defeater_ids": ["D-REPEATED-SEPARATOR"],
                },
            ],
        }
        execution_environment = {
            name: os.environ[name]
            for name in contract["control_plane"]["environment_allowlist"]
        }
        environment_identity = vdd_accept.derive_environment_identity(
            execution_environment,
            contract["control_plane"]["execution_plan"],
            workspace,
        )
        contract["environment"] = {
            "digest": environment_identity["digest"],
            "required": contract["control_plane"]["environment_allowlist"],
            "matrix": [],
            "fingerprint_fields": [
                "allowlisted variables",
                "executables",
                "runtime",
            ],
        }
        evidence["environment"] = copy.deepcopy(environment_identity)
        evidence["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
        evidence["commands"] = []
        evidence["candidate"]["artifact_digests"] = []
        evidence["claim_results"][0]["evidence_refs"] = ["CHECK"]
        evidence["defeater_results"][0]["evidence_refs"] = ["BAD", "CHECK"]
        evidence["mode_evidence"] = {
            "semantic_red_command": "BAD",
            "focused_green_commands": ["CHECK"],
            "boundary_commands": ["CHECK"],
        }
        return contract, evidence, protected


    def test_issue_executes_snapshot_plan_and_signs_attestation(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            proposal["test_discovery"]["discovered"] = 0
            proposal["oracles"][0]["no_change_trials"] = 99
            proposal["oracles"][0]["flake_rate"] = 0.9
            proposal["oracles"][0]["known_bad_rejections"] = []
            proposal["test_discovery"]["executed"] = 0
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-1",
            )
            self.assertEqual("vdd_accept", attestation["control_plane"]["issuer"])
            self.assertTrue(attestation["control_plane"]["signature"])
            self.assertEqual(
                ["pass", "expected_reject", "pass", "pass", "pass"],
                [record["result"] for record in attestation["commands"]],
            )
            self.assertEqual(
                contract["test_discovery"]["expected"],
                attestation["test_discovery"]["discovered"],
            )
            self.assertTrue(attestation["control_plane"]["candidate_snapshot_before"])
            self.assertEqual(
                attestation["control_plane"]["candidate_snapshot_before"],
                attestation["control_plane"]["candidate_snapshot_after"],
            )
            self.assertEqual(
                vdd_accept.canonical_digest(
                    attestation["control_plane"]["candidate_snapshot_before"]
                ),
                attestation["candidate"]["revision"],
            )
            self.assertFalse(attestation["candidate"]["dirty"])
            self.assertEqual(0, attestation["oracles"][0]["no_change_trials"])
            self.assertEqual(0.0, attestation["oracles"][0]["flake_rate"])
            self.assertEqual(
                ["D-REPEATED-SEPARATOR"],
                attestation["oracles"][0]["known_bad_rejections"],
            )
            self.assertEqual(
                attestation["control_plane"]["protected_snapshot_before"],
                attestation["control_plane"]["protected_snapshot_after"],
            )
            schema_errors = list(
                Draft202012Validator(load("schemas/evidence.schema.json")).iter_errors(
                    attestation
                )
            )
            self.assertEqual([], schema_errors)
            self.assertTrue(
                vdd_accept.verify_attestation_signature(
                    attestation,
                    b"control-plane-secret",
                )
            )

    def test_issue_snapshot_does_not_use_path_based_copytree(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            with mock.patch.object(
                vdd_accept.shutil,
                "copytree",
                side_effect=AssertionError("path-based copytree must not own the snapshot"),
            ):
                attestation = vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="rooted-snapshot-copy",
                )
            self.assertEqual("accepted", attestation["status"])

    def test_issue_retains_signed_command_outputs_and_verify_detects_tampering(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            output_directory = Path(tmp) / "retained-evidence"
            contract, proposal, _ = self.make_case(workspace)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-retained-output",
                output_directory=output_directory,
            )

            rejection = next(
                command for command in attestation["commands"] if command["id"] == "BAD"
            )
            stderr = rejection["output_capture"]["stderr"]
            self.assertEqual(
                b"A__B differs: a--b != a-b\n",
                (output_directory / stderr["path"]).read_bytes(),
            )
            self.assertTrue(rejection["output_capture"]["isolation"]["path"])
            with self.assertRaisesRegex(ValueError, "verification requires output_directory"):
                vdd_accept.verify_attestation_bundle(
                    attestation,
                    contract,
                    b"control-plane-secret",
                )
            vdd_accept.verify_attestation_bundle(
                attestation,
                contract,
                b"control-plane-secret",
                output_directory=output_directory,
            )

            (output_directory / stderr["path"]).write_bytes(b"replaced\n")
            with self.assertRaisesRegex(ValueError, "command output.*differs"):
                vdd_accept.verify_attestation_bundle(
                    attestation,
                    contract,
                    b"control-plane-secret",
                    output_directory=output_directory,
                )

    def test_verify_rejects_invalid_signature_before_source_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, _, _ = self.make_case(workspace)
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": "a" * 40,
                "require_clean": True,
            }
            with mock.patch.object(
                vdd_accept,
                "_capture_source_provenance",
                side_effect=AssertionError("invalid signatures must not scan source"),
            ):
                with self.assertRaisesRegex(ValueError, "signature.*invalid"):
                    vdd_accept.verify_attestation_bundle(
                        {},
                        contract,
                        b"control-plane-secret",
                        source_workspace=workspace,
                    )

    def test_retained_output_issue_accepts_a_pinned_source_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            source = root / "source"
            workspace.mkdir()
            source.mkdir()
            retained = root / "retained"
            with vdd_accept._PinnedWorkspace(source) as pinned, mock.patch.object(
                vdd_accept,
                "_issue_attestation",
                return_value={},
            ):
                result = vdd_accept.issue_attestation(
                    {},
                    {},
                    workspace=workspace,
                    signing_key=b"secret",
                    run_id="pinned-source",
                    output_directory=retained,
                    source_workspace=pinned,
                )
            self.assertEqual({}, result)
            self.assertTrue(retained.is_dir())

    def test_failed_retained_output_issuance_does_not_publish_or_block_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            retained = root / "retained"
            contract, proposal, _ = self.make_case(workspace)
            failing_step = next(
                step
                for step in contract["control_plane"]["execution_plan"]
                if step["id"] == "CHECK"
            )
            failing_step["expected_exit_code"] = 1

            with self.assertRaisesRegex(ValueError, "acceptance command CHECK exited"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-retained-failure",
                    output_directory=retained,
                )
            self.assertFalse(retained.exists())

            failing_step["expected_exit_code"] = 0
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-retained-retry",
                output_directory=retained,
            )
            self.assertTrue(retained.is_dir())
            self.assertEqual(str(retained), attestation["control_plane"]["output_directory"])

    def test_successful_retained_output_directory_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            retained = root / "retained"
            contract, proposal, _ = self.make_case(workspace)
            vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-retained-first",
                output_directory=retained,
            )

            with self.assertRaisesRegex(ValueError, "output directory already exists"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-retained-second",
                    output_directory=retained,
                )

    def test_retained_output_publication_never_replaces_a_competing_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            final_directory = root / "retained"
            publication = vdd_accept._RetainedOutputPublication(final_directory)
            with publication:
                competing_root = root / "retained"
                competing_root.mkdir()
                sentinel = competing_root / "sentinel.txt"
                sentinel.write_text("do not replace\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "output directory already exists"):
                    publication.publish()
                self.assertEqual("do not replace\n", sentinel.read_text(encoding="utf-8"))
            self.assertEqual("do not replace\n", sentinel.read_text(encoding="utf-8"))
            self.assertFalse(any(root.glob(".vdd-accept-*.staging")))

    def test_retained_output_verification_rejects_oversized_replacement_before_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            retained = root / "retained"
            contract, proposal, _ = self.make_case(workspace)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-retained-oversized",
                output_directory=retained,
            )
            capture = attestation["commands"][0]["output_capture"]["stdout"]
            replacement = retained / capture["path"]
            replacement.unlink()
            with replacement.open("wb") as handle:
                handle.truncate(vdd_accept.ACCEPTANCE_OUTPUT_LIMIT_BYTES + 1)
            with mock.patch.object(
                vdd_accept.os,
                "fdopen",
                side_effect=AssertionError("oversized retained output must not be read"),
            ):
                with self.assertRaisesRegex(ValueError, "command output differs"):
                    vdd_accept.verify_attestation_bundle(
                        attestation,
                        contract,
                        b"control-plane-secret",
                        output_directory=retained,
                    )

    @unittest.skipUnless(hasattr(os, "mkfifo"), "requires POSIX FIFO support")
    def test_control_plane_artifact_readers_reject_fifo_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fifo = root / "artifact"
            os.mkfifo(fifo)
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, "regular file"):
                vdd_accept._load_control_plane_json(fifo)
            with self.assertRaisesRegex(ValueError, "regular file"):
                vdd_accept._read_retained_regular_file(
                    root,
                    fifo.name,
                    max_bytes=1024,
                )
            self.assertLess(time.monotonic() - started, 1)

    def test_retained_output_reader_rejects_same_length_in_place_rewrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / "artifact"
            artifact.write_bytes(b"before")
            real_stat = os.stat
            replaced = False

            def rewrite_before_final_stat(path, *args, **kwargs):
                nonlocal replaced
                if path == artifact.name and kwargs.get("dir_fd") is not None and not replaced:
                    replaced = True
                    artifact.write_bytes(b"after!")
                return real_stat(path, *args, **kwargs)

            with mock.patch.object(
                vdd_accept.os,
                "stat",
                side_effect=rewrite_before_final_stat,
            ):
                with self.assertRaisesRegex(ValueError, "changed while reading"):
                    vdd_accept._read_retained_regular_file(
                        root,
                        artifact.name,
                        max_bytes=1024,
                    )

    def test_retained_output_capture_requires_an_attested_control_plane_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-output-root-required",
            )
            attestation["commands"][0]["output_capture"] = {
                "stdout": {"path": "commands/test/stdout.bin", "byte_length": 0, "digest": "sha256:" + "0" * 64, "fingerprint": "sha256:" + "0" * 64},
                "stderr": {"path": "commands/test/stderr.bin", "byte_length": 0, "digest": "sha256:" + "0" * 64, "fingerprint": "sha256:" + "0" * 64},
                "isolation": {"path": "commands/test/isolation.bin", "fingerprint": "sha256:" + "0" * 64, "provider": "test", "policy_format": "test", "executable_fingerprint": "sha256:" + "0" * 64},
            }
            attestation["control_plane"]["attestation_digest"] = vdd_accept.attestation_digest(attestation)
            attestation["control_plane"]["signature"] = vdd_accept.sign_attestation(attestation, b"control-plane-secret")
            with self.assertRaisesRegex(ValueError, "output capture requires output_directory"):
                vdd_accept.verify_attestation_bundle(
                    attestation, contract, b"control-plane-secret"
                )

    def test_retained_output_verification_rejects_a_different_control_plane_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            retained = root / "retained"
            other_root = root / "other-retained"
            other_root.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-retained-root",
                output_directory=retained,
            )
            with self.assertRaisesRegex(ValueError, "output directory differs"):
                vdd_accept.verify_attestation_bundle(
                    attestation,
                    contract,
                    b"control-plane-secret",
                    output_directory=other_root,
                )

    def test_retained_output_uses_confined_step_directory_and_canonical_byte_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            output_directory = root / "retained-evidence"
            contract, proposal, _ = self.make_case(workspace)
            contract["control_plane"]["execution_plan"][0]["id"] = "../../escaped"
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-confined-output",
                output_directory=output_directory,
            )

            capture = attestation["commands"][0]["output_capture"]["stdout"]
            self.assertEqual(
                hashlib.sha256(
                    (output_directory / capture["path"]).read_bytes()
                ).hexdigest(),
                capture["digest"].removeprefix("sha256:"),
            )
            self.assertNotIn("..", Path(capture["path"]).parts)
            self.assertFalse((root / "escaped").exists())
            self.assertNotIn("stdout_digest", attestation["commands"][0])
            self.assertNotIn("stderr_digest", attestation["commands"][0])

            capture["digest"] = "sha256:" + "0" * 64
            attestation["control_plane"]["attestation_digest"] = (
                vdd_accept.attestation_digest(attestation)
            )
            attestation["control_plane"]["signature"] = vdd_accept.sign_attestation(
                attestation,
                b"control-plane-secret",
            )
            with self.assertRaisesRegex(ValueError, "command output digest differs"):
                vdd_accept.verify_attestation_bundle(
                    attestation,
                    contract,
                    b"control-plane-secret",
                    output_directory=output_directory,
                )

    def test_source_provenance_git_queries_disable_checkout_fsmonitor(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "upstream-checkout"
            source.mkdir()
            marker = Path(tmp) / "fsmonitor-ran"
            hook = Path(tmp) / "fsmonitor.sh"
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            hook.write_text(
                f"#!/bin/sh\nprintf triggered > {marker}\nexit 0\n",
                encoding="utf-8",
            )
            hook.chmod(0o755)
            subprocess.run(
                ["git", "config", "core.fsmonitor", str(hook)],
                cwd=source,
                check=True,
            )

            self.assertEqual("", vdd_accept._git_output(source, "status", "--porcelain"))
            self.assertFalse(marker.exists())

    def test_source_provenance_git_queries_ignore_inherited_git_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "upstream-checkout"
            source.mkdir()
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            with mock.patch.dict(os.environ, {"GIT_DIR": str(Path(tmp) / "not-a-repository")}):
                self.assertEqual("", vdd_accept._git_output(source, "status", "--porcelain"))

    def test_source_provenance_pins_git_executable_before_repository_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "upstream-checkout"
            source.mkdir()
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            marker = root / "fake-git-ran"
            fake_git = fake_bin / "git"
            fake_git.write_text(
                f"#!/bin/sh\nprintf ran > {marker}\nprintf forged\n",
                encoding="utf-8",
            )
            fake_git.chmod(0o755)

            with mock.patch.dict(os.environ, {"PATH": str(fake_bin)}):
                observed = vdd_accept._git_output(
                    source,
                    "rev-parse",
                    "--verify",
                    "HEAD^{commit}",
                )
            self.assertEqual(revision, observed)
            self.assertFalse(marker.exists())

    def test_source_provenance_rejects_pinned_git_generation_drift(self):
        if vdd_accept._PINNED_GIT_EXECUTABLE is None:
            self.skipTest("trusted git executable is unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "upstream-checkout"
            source.mkdir()
            with mock.patch.object(
                vdd_accept,
                "_git_executable_identity",
                return_value=(0, 0, 0, 0, 0, 0),
            ):
                with self.assertRaisesRegex(ValueError, "git executable changed"):
                    vdd_accept._git_output(source, "status", "--porcelain")

    def test_source_provenance_git_launcher_ignores_python_startup_injection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "upstream-checkout"
            startup = root / "startup"
            source.mkdir()
            startup.mkdir()
            marker = root / "sitecustomize-ran"
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            (startup / "sitecustomize.py").write_text(
                f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n",
                encoding="utf-8",
            )
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)

            with mock.patch.dict(os.environ, {"PYTHONPATH": str(startup)}):
                vdd_accept._git_output(
                    source,
                    "rev-parse",
                    "--verify",
                    "HEAD^{commit}",
                )
            self.assertFalse(marker.exists())

    def test_source_provenance_ignores_untrusted_path_during_module_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "upstream-checkout"
            source.mkdir()
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            marker = root / "startup-fake-git-ran"
            fake_git = fake_bin / "git"
            fake_git.write_text(
                f"#!/bin/sh\nprintf ran > {marker}\nprintf forged\n",
                encoding="utf-8",
            )
            fake_git.chmod(0o755)
            script = (
                "from pathlib import Path\n"
                "import vdd_accept\n"
                "print(vdd_accept._git_output("
                "Path(__import__('sys').argv[1]),"
                "'rev-parse','--verify','HEAD^{commit}'))\n"
            )
            environment = {
                **os.environ,
                "PATH": str(fake_bin),
                "PYTHONPATH": str(TOOLS),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            completed = subprocess.run(
                [sys.executable, "-c", script, str(source)],
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                timeout=10,
            )
            self.assertEqual(revision, completed.stdout.strip())
            self.assertFalse(marker.exists())

    def test_source_provenance_reads_raw_local_origin_without_url_rewrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "upstream-checkout"
            source.mkdir()
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "ssh://upstream.invalid/repository.git"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "url.https://rewritten.invalid/.insteadOf", "ssh://upstream.invalid/"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            contract = {
                "source_provenance": {
                    "repository": "ssh://upstream.invalid/repository.git",
                    "revision": revision,
                    "require_clean": True,
                }
            }
            observed = vdd_accept._capture_source_provenance(contract, source)
            self.assertEqual(revision, observed["revision"])

    def test_issue_rejects_untracked_source_material_hidden_by_local_status_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            (source / "undeclared.txt").write_text("must be rejected\n", encoding="utf-8")
            subprocess.run(
                ["git", "config", "status.showUntrackedFiles", "no"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)

            with self.assertRaisesRegex(ValueError, "source provenance workspace is dirty"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    source_workspace=source,
                    signing_key=b"control-plane-secret",
                    run_id="run-hidden-untracked-source",
                )

    def test_issue_rejects_ignored_source_material(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            (source / ".gitignore").write_text("*.scratch\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt", ".gitignore"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            (source / "nested").mkdir()
            (source / "nested" / "undeclared.scratch").write_text(
                "must be rejected\n", encoding="utf-8"
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)

            with self.assertRaisesRegex(ValueError, "source provenance workspace is dirty"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    source_workspace=source,
                    signing_key=b"control-plane-secret",
                    run_id="run-ignored-source",
                )

    def test_source_provenance_rejects_index_flags_that_hide_tracked_changes(self):
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as tmp:
                source = Path(tmp)
                tracked = source / "candidate.txt"
                tracked.write_text("candidate\n", encoding="utf-8")
                subprocess.run(["git", "init", "-q"], cwd=source, check=True)
                subprocess.run(
                    ["git", "config", "user.email", "vdd@example.invalid"],
                    cwd=source,
                    check=True,
                )
                subprocess.run(
                    ["git", "config", "user.name", "VDD Test"],
                    cwd=source,
                    check=True,
                )
                subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
                subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
                subprocess.run(
                    [
                        "git",
                        "remote",
                        "add",
                        "origin",
                        "https://example.invalid/pinned-source.git",
                    ],
                    cwd=source,
                    check=True,
                )
                revision = subprocess.check_output(
                    ["git", "rev-parse", "HEAD"],
                    cwd=source,
                    text=True,
                ).strip()
                subprocess.run(
                    ["git", "update-index", flag, "candidate.txt"],
                    cwd=source,
                    check=True,
                )
                tracked.write_text("hidden change\n", encoding="utf-8")
                contract = {
                    "source_provenance": {
                        "repository": "https://example.invalid/pinned-source.git",
                        "revision": revision,
                        "require_clean": True,
                    }
                }
                with self.assertRaisesRegex(
                    ValueError,
                    "index flag|workspace is dirty",
                ):
                    vdd_accept._capture_source_provenance(contract, source)

    def test_source_provenance_rejects_staged_only_index_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)
            tracked = source / "candidate.txt"
            original = "candidate\n"
            tracked.write_text(original, encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                [
                    "git",
                    "remote",
                    "add",
                    "origin",
                    "https://example.invalid/pinned-source.git",
                ],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            tracked.write_text("staged change\n", encoding="utf-8")
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            tracked.write_text(original, encoding="utf-8")
            contract = {
                "source_provenance": {
                    "repository": "https://example.invalid/pinned-source.git",
                    "revision": revision,
                    "require_clean": True,
                }
            }
            with self.assertRaisesRegex(ValueError, "workspace is dirty"):
                vdd_accept._capture_source_provenance(contract, source)

    def test_source_provenance_does_not_execute_repository_filter_drivers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            source.mkdir()
            marker = root / "filter-executed"
            filter_script = root / "filter.sh"
            filter_script.write_text(
                "#!/bin/sh\n"
                f"touch {str(marker)!r}\n"
                "cat\n",
                encoding="utf-8",
            )
            filter_script.chmod(0o755)
            candidate = source / "candidate.txt"
            candidate.write_text("candidate\n", encoding="utf-8")
            (source / ".gitattributes").write_text(
                "candidate.txt filter=untrusted\n",
                encoding="utf-8",
            )
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(
                ["git", "config", "user.email", "vdd@example.invalid"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "VDD Test"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "add", "candidate.txt", ".gitattributes"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "commit", "-qm", "filter fixture"], cwd=source, check=True)
            subprocess.run(
                [
                    "git",
                    "remote",
                    "add",
                    "origin",
                    "https://example.invalid/pinned-source.git",
                ],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "filter.untrusted.clean", str(filter_script)],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "filter.untrusted.required", "true"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            candidate.write_text("candidate\n", encoding="utf-8")
            vdd_accept._capture_source_provenance(
                {
                    "source_provenance": {
                        "repository": "https://example.invalid/pinned-source.git",
                        "revision": revision,
                        "require_clean": True,
                    }
                },
                source,
            )
            self.assertFalse(marker.exists(), "Git provenance executed a repository filter")

    def test_source_provenance_checks_declared_root_not_local_core_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            alternate = root / "alternate"
            source.mkdir()
            alternate.mkdir()
            candidate = source / "candidate.txt"
            candidate.write_text("candidate\n", encoding="utf-8")
            (alternate / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(
                ["git", "config", "user.email", "vdd@example.invalid"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "VDD Test"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "worktree fixture"], cwd=source, check=True)
            subprocess.run(
                [
                    "git",
                    "remote",
                    "add",
                    "origin",
                    "https://example.invalid/pinned-source.git",
                ],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            subprocess.run(
                ["git", "config", "core.worktree", str(alternate)],
                cwd=source,
                check=True,
            )
            candidate.write_text("dirty declared root\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "workspace is dirty"):
                vdd_accept._capture_source_provenance(
                    {
                        "source_provenance": {
                            "repository": "https://example.invalid/pinned-source.git",
                            "revision": revision,
                            "require_clean": True,
                        }
                    },
                    source,
                )

    def test_source_provenance_pins_checkout_generation_across_git_and_file_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            moved = root / "moved-source"
            source.mkdir()
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(
                ["git", "config", "user.email", "vdd@example.invalid"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "VDD Test"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "pinned root fixture"], cwd=source, check=True)
            subprocess.run(
                [
                    "git",
                    "remote",
                    "add",
                    "origin",
                    "https://example.invalid/pinned-source.git",
                ],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            contract = {
                "source_provenance": {
                    "repository": "https://example.invalid/pinned-source.git",
                    "revision": revision,
                    "require_clean": True,
                }
            }
            with vdd_accept._PinnedWorkspace(source) as pinned:
                source.rename(moved)
                source.mkdir()
                (source / "candidate.txt").write_text("replacement\n", encoding="utf-8")
                observed = vdd_accept._capture_source_provenance(contract, pinned)
            self.assertEqual(revision, observed["revision"])
            self.assertTrue(observed["clean"])

    def test_git_tree_entry_treats_artifact_name_as_literal(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)
            relative = ":(literal)candidate.txt"
            (source / relative).write_text("candidate\n", encoding="utf-8")
            (source / "candidate.txt").write_text("different\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(
                ["git", "config", "user.email", "vdd@example.invalid"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "VDD Test"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "--literal-pathspecs", "add", "--", relative, "candidate.txt"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "commit", "-qm", "literal path fixture"], cwd=source, check=True)
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            entry = vdd_accept._git_tree_entry(source, revision, relative)
            self.assertEqual("file", entry["git_type"])
            self.assertRegex(entry["git_object"], r"^[0-9a-f]{40,64}$")

    def test_git_tree_entry_ignores_repository_replace_refs(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)
            candidate = source / "candidate.txt"
            candidate.write_text("first\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(
                ["git", "config", "user.email", "vdd@example.invalid"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "VDD Test"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "first"], cwd=source, check=True)
            first = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            candidate.write_text("second\n", encoding="utf-8")
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "second"], cwd=source, check=True)
            second = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            subprocess.run(["git", "replace", second, first], cwd=source, check=True)
            expected = subprocess.check_output(
                [
                    "git",
                    "--no-replace-objects",
                    "ls-tree",
                    second,
                    "--",
                    "candidate.txt",
                ],
                cwd=source,
                text=True,
            ).split()[2]
            observed = vdd_accept._git_tree_entry(source, second, "candidate.txt")
            self.assertEqual(expected, observed["git_object"])

    def test_git_provenance_output_is_bounded(self):
        command = [
            sys.executable,
            "-c",
            "import os; os.write(1, b'x' * (9 * 1024 * 1024))",
        ]
        with mock.patch.object(vdd_accept, "_git_command", return_value=command):
            with self.assertRaisesRegex(ValueError, "stdout exceeded bounded output limit"):
                vdd_accept._git_bytes(Path.cwd(), "status")

    def test_git_provenance_command_has_a_deadline(self):
        command = [sys.executable, "-c", "import time; time.sleep(30)"]
        started = time.monotonic()
        with mock.patch.object(
            vdd_accept,
            "_git_command",
            return_value=command,
        ), mock.patch.object(
            vdd_accept,
            "GIT_COMMAND_TIMEOUT_SECONDS",
            0.1,
        ):
            with self.assertRaisesRegex(ValueError, "timed out after 0.1s"):
                vdd_accept._git_bytes(Path.cwd(), "status")
        self.assertLess(time.monotonic() - started, 2)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "requires POSIX FIFO support")
    def test_source_provenance_rejects_fifo_candidate_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            candidate = root / "candidate"
            source.mkdir()
            candidate.mkdir()
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            os.mkfifo(candidate / "candidate.txt")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(
                ["git", "config", "user.email", "vdd@example.invalid"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "VDD Test"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "fifo fixture"], cwd=source, check=True)
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            script = (
                "import sys\n"
                "from pathlib import Path\n"
                "sys.path.insert(0, sys.argv[1])\n"
                "import vdd_accept\n"
                "provenance = {'repository': 'fixture', 'revision': sys.argv[4], 'clean': True}\n"
                "try:\n"
                "    vdd_accept._bind_source_candidate_artifacts(\n"
                "        provenance,\n"
                "        source_workspace=Path(sys.argv[2]),\n"
                "        candidate_workspace=Path(sys.argv[3]),\n"
                "        candidate_snapshot=[{'path': 'candidate.txt', 'fingerprint': 'sha256:' + '0' * 64}],\n"
                "    )\n"
                "except ValueError:\n"
                "    raise SystemExit(0)\n"
                "raise SystemExit(2)\n"
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    script,
                    str(TOOLS),
                    str(source),
                    str(candidate),
                    revision,
                ],
                check=False,
                timeout=5,
            )
            self.assertEqual(0, completed.returncode)

    def test_source_provenance_observes_candidate_once_for_snapshot_and_git_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            candidate = root / "candidate"
            source.mkdir()
            candidate.mkdir()
            (source / "candidate.txt").write_text("pinned\n", encoding="utf-8")
            candidate_path = candidate / "candidate.txt"
            candidate_path.write_text("snapshot-only\n", encoding="utf-8")
            replacement = candidate / "replacement.txt"
            replacement.write_text("pinned\n", encoding="utf-8")
            snapshot_fingerprint = vdd_accept.file_fingerprint(candidate_path)
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(
                ["git", "config", "user.email", "vdd@example.invalid"],
                cwd=source,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "VDD Test"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "single observation fixture"], cwd=source, check=True)
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()
            candidate_identity = (candidate.stat().st_dev, candidate.stat().st_ino)
            original_open = vdd_accept.os.open
            swapped = False

            def racing_open(path, flags, *args, dir_fd=None, **kwargs):
                nonlocal swapped
                fd = original_open(path, flags, *args, dir_fd=dir_fd, **kwargs)
                if (
                    not swapped
                    and path == "candidate.txt"
                    and dir_fd is not None
                    and (os.fstat(dir_fd).st_dev, os.fstat(dir_fd).st_ino)
                    == candidate_identity
                ):
                    os.replace(replacement, candidate_path)
                    swapped = True
                return fd

            with mock.patch.object(vdd_accept.os, "open", side_effect=racing_open):
                with self.assertRaisesRegex(
                    ValueError,
                    "source provenance differs for candidate artifact",
                ):
                    vdd_accept._bind_source_candidate_artifacts(
                        {
                            "repository": "fixture",
                            "revision": revision,
                            "clean": True,
                        },
                        source_workspace=source,
                        candidate_workspace=candidate,
                        candidate_snapshot=[
                            {
                                "path": "candidate.txt",
                                "fingerprint": snapshot_fingerprint,
                            }
                        ],
                    )
            self.assertTrue(swapped)

    def test_issue_binds_and_reverifies_declared_git_source_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            output_directory = root / "retained-evidence"
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                source_workspace=source,
                output_directory=output_directory,
                signing_key=b"control-plane-secret",
                run_id="run-source-provenance",
            )
            observed = attestation["control_plane"]["source_provenance"]
            self.assertEqual(revision, observed["revision"])
            self.assertTrue(observed["clean"])
            vdd_accept.verify_attestation_bundle(
                attestation,
                contract,
                b"control-plane-secret",
                source_workspace=source,
                output_directory=output_directory,
            )

            (source / "candidate.txt").write_text("changed\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "source provenance workspace is dirty|source provenance differs"):
                vdd_accept.verify_attestation_bundle(
                    attestation,
                    contract,
                    b"control-plane-secret",
                    source_workspace=source,
                )

    def test_source_provenance_rejects_candidate_artifact_absent_from_pinned_git_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "README.txt").write_text("source\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "README.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)

            with self.assertRaisesRegex(
                ValueError, "source provenance candidate artifact is absent"
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    source_workspace=source,
                    signing_key=b"control-plane-secret",
                    run_id="run-missing-source-artifact",
                )

    def test_source_provenance_rejects_retained_output_inside_source_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)

            with self.assertRaisesRegex(ValueError, "output directory overlaps source workspace"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    source_workspace=source,
                    output_directory=source / "retained-evidence",
                    signing_key=b"control-plane-secret",
                    run_id="run-output-inside-source",
                )

    def test_source_provenance_rechecks_source_state_before_signing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            original_execute = vdd_accept._execute_plan

            def mutate_source(*args, **kwargs):
                records = original_execute(*args, **kwargs)
                (source / "candidate.txt").write_text("changed\n", encoding="utf-8")
                return records

            with mock.patch.object(vdd_accept, "_execute_plan", side_effect=mutate_source):
                with self.assertRaisesRegex(
                    ValueError,
                    "source provenance workspace is dirty|source provenance changed during acceptance",
                ):
                    vdd_accept.issue_attestation(
                        contract,
                        proposal,
                        workspace=workspace,
                        source_workspace=source,
                        signing_key=b"control-plane-secret",
                        run_id="run-source-drift",
                    )

    def test_source_provenance_cleanliness_handles_non_utf8_git_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "upstream-checkout"
            source.mkdir()
            raw_name = b"\xff-source.bin"
            raw_path = os.fsencode(source) + b"/" + raw_name
            try:
                fd = os.open(
                    raw_path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o644,
                )
            except OSError as exc:
                if exc.errno == errno.EILSEQ:
                    self.skipTest("filesystem rejects non-UTF-8 path bytes")
                raise
            try:
                os.write(fd, b"source\n")
            finally:
                os.close(fd)
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "--all"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()

            self.assertTrue(
                vdd_accept._source_workspace_is_clean(source, revision)
            )

    def test_source_provenance_cleanliness_supports_git_submodules(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            upstream = root / "submodule-upstream"
            source = root / "upstream-checkout"
            upstream.mkdir()
            source.mkdir()
            (upstream / "library.txt").write_text("library\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=upstream, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=upstream, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=upstream, check=True)
            subprocess.run(["git", "add", "library.txt"], cwd=upstream, check=True)
            subprocess.run(["git", "commit", "-qm", "library fixture"], cwd=upstream, check=True)

            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "protocol.file.allow=always",
                    "submodule",
                    "add",
                    "-q",
                    str(upstream),
                    "deps/library",
                ],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "commit", "-qam", "source fixture"], cwd=source, check=True)
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                text=True,
            ).strip()

            self.assertTrue(
                vdd_accept._source_workspace_is_clean(source, revision)
            )
            (source / "deps" / "library" / "untracked.txt").write_text(
                "dirty\n",
                encoding="utf-8",
            )
            self.assertFalse(
                vdd_accept._source_workspace_is_clean(source, revision)
            )

    def test_source_provenance_accepts_clean_non_executable_group_writable_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"], cwd=source, check=True)
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            (source / "candidate.txt").chmod(0o664)
            self.assertEqual("", subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True))
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)

            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                source_workspace=source,
                signing_key=b"control-plane-secret",
                run_id="run-source-group-writable",
            )
            self.assertEqual(revision, attestation["control_plane"]["source_provenance"]["revision"])
            vdd_accept.verify_attestation_bundle(
                attestation,
                contract,
                b"control-plane-secret",
                source_workspace=source,
            )

    def test_source_provenance_rejects_regular_file_mode_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"], cwd=source, check=True)
            subprocess.run(["git", "config", "core.fileMode", "false"], cwd=source, check=True)
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            (source / "candidate.txt").chmod(0o755)
            self.assertEqual("", subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True))
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "^source provenance workspace is dirty$"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    source_workspace=source,
                    signing_key=b"control-plane-secret",
                    run_id="run-source-mode-drift",
                )

    def test_source_provenance_rejects_regular_file_mode_drift_when_cleanliness_is_optional(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            (source / "candidate.txt").chmod(0o755)
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": False,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError,
                "^source provenance differs for candidate artifact: candidate\\.txt$",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    source_workspace=source,
                    signing_key=b"control-plane-secret",
                    run_id="run-source-mode-drift-optional-cleanliness",
                )

    def test_source_provenance_rejects_intermediate_symlink_ancestor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            outside = root / "outside"
            workspace.mkdir()
            source.mkdir()
            outside.mkdir()
            (source / "nested").mkdir()
            (source / "nested" / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            (workspace / "nested").mkdir()
            (workspace / "nested" / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "nested/candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            (outside / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            (source / "nested" / "candidate.txt").unlink()
            (source / "nested").rmdir()
            (source / "nested").symlink_to(outside, target_is_directory=True)
            contract = {
                "source_provenance": {
                    "repository": "https://example.invalid/pinned-source.git",
                    "revision": revision,
                    "require_clean": False,
                }
            }
            provenance = vdd_accept._capture_source_provenance(contract, source)
            with self.assertRaisesRegex(ValueError, "source provenance differs for candidate artifact"):
                vdd_accept._bind_source_candidate_artifacts(
                    provenance,
                    source_workspace=source,
                    candidate_snapshot=[
                        {
                            "path": "nested/candidate.txt",
                            "fingerprint": vdd_accept.file_fingerprint(
                                workspace / "nested" / "candidate.txt"
                            ),
                        }
                    ],
                    candidate_workspace=workspace,
                )

    def test_source_provenance_rejects_candidate_snapshot_fingerprint_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            (workspace / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            provenance = vdd_accept._capture_source_provenance(
                {
                    "source_provenance": {
                        "repository": "https://example.invalid/pinned-source.git",
                        "revision": revision,
                        "require_clean": True,
                    }
                },
                source,
            )
            (workspace / "candidate.txt").write_text("stale\n", encoding="utf-8")
            stale_fingerprint = vdd_accept.file_fingerprint(workspace / "candidate.txt")
            (workspace / "candidate.txt").write_text("candidate\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "source provenance differs for candidate artifact"):
                vdd_accept._bind_source_candidate_artifacts(
                    provenance,
                    source_workspace=source,
                    candidate_snapshot=[
                        {"path": "candidate.txt", "fingerprint": stale_fingerprint}
                    ],
                    candidate_workspace=workspace,
                )

    def test_source_provenance_rejects_candidate_symlink_snapshot_fingerprint_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            for directory in (source, workspace):
                (directory / "candidate-target.txt").write_text("candidate\n", encoding="utf-8")
                (directory / "candidate.txt").symlink_to("candidate-target.txt")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(
                ["git", "add", "candidate.txt", "candidate-target.txt"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            provenance = vdd_accept._capture_source_provenance(
                {
                    "source_provenance": {
                        "repository": "https://example.invalid/pinned-source.git",
                        "revision": revision,
                        "require_clean": True,
                    }
                },
                source,
            )
            (workspace / "candidate.txt").unlink()
            (workspace / "candidate.txt").symlink_to("stale-target.txt")
            stale_fingerprint = vdd_accept._filesystem_entry_fingerprint(
                workspace / "candidate.txt"
            )
            (workspace / "candidate.txt").unlink()
            (workspace / "candidate.txt").symlink_to("candidate-target.txt")

            with self.assertRaisesRegex(ValueError, "source provenance differs for candidate artifact"):
                vdd_accept._bind_source_candidate_artifacts(
                    provenance,
                    source_workspace=source,
                    candidate_snapshot=[
                        {
                            "path": "candidate-target.txt",
                            "fingerprint": vdd_accept.file_fingerprint(
                                workspace / "candidate-target.txt"
                            ),
                        },
                        {"path": "candidate.txt", "fingerprint": stale_fingerprint},
                    ],
                    candidate_workspace=workspace,
                )

    def test_protected_symlink_requires_separately_protected_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "target.txt").write_text("protected target\n", encoding="utf-8")
            (workspace / "link.txt").symlink_to("target.txt")
            contract = {
                "control_plane": {
                    "protected_assets": [
                        {
                            "path": "link.txt",
                            "fingerprint": vdd_accept._filesystem_entry_fingerprint(
                                workspace / "link.txt"
                            ),
                        }
                    ]
                }
            }
            with self.assertRaisesRegex(
                ValueError,
                "protected symlink target must be separately protected",
            ):
                vdd_accept._verify_protected_assets(contract, workspace)

    def test_source_provenance_accepts_non_owner_execute_bits_for_non_executable_git_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"], cwd=source, check=True)
            subprocess.run(["git", "config", "core.fileMode", "false"], cwd=source, check=True)
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            (source / "candidate.txt").chmod(0o654)
            (workspace / "candidate.txt").chmod(0o654)
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                source_workspace=source,
                signing_key=b"control-plane-secret",
                run_id="run-source-owner-execute",
            )
            self.assertEqual(revision, attestation["control_plane"]["source_provenance"]["revision"])

    def test_protected_symlink_requires_every_link_in_its_chain_to_be_protected(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "target.txt").write_text("protected target\n", encoding="utf-8")
            (workspace / "middle.txt").symlink_to("target.txt")
            (workspace / "link.txt").symlink_to("middle.txt")
            contract = {
                "control_plane": {
                    "protected_assets": [
                        {
                            "path": "link.txt",
                            "fingerprint": vdd_accept._filesystem_entry_fingerprint(
                                workspace / "link.txt"
                            ),
                        },
                        {
                            "path": "target.txt",
                            "fingerprint": vdd_accept.file_fingerprint(
                                workspace / "target.txt"
                            ),
                        },
                    ]
                }
            }
            with self.assertRaisesRegex(
                ValueError,
                "protected symlink target must be separately protected",
            ):
                vdd_accept._verify_protected_assets(contract, workspace)

    def test_real_upstream_workflow_binds_pinned_git_symlink_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "upstream-checkout"
            source.mkdir()
            (source / "tests").mkdir()
            (source / "tests" / "real.py").write_text("test contents\n", encoding="utf-8")
            (source / "tests" / "focused.py").symlink_to("real.py")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "tests/real.py", "tests/focused.py"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"], cwd=source, check=True)
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            contract = {
                "source_provenance": {
                    "repository": "https://example.invalid/pinned-source.git",
                    "revision": revision,
                    "require_clean": True,
                },
                "real_upstream_workflow": {
                    "focused_artifacts": ["tests/focused.py"],
                    "broad_artifacts": ["tests/focused.py", "tests/real.py"],
                },
                "control_plane": {
                    "protected_assets": [
                        {
                            "path": "tests/focused.py",
                            "fingerprint": vdd_accept._filesystem_entry_fingerprint(
                                source / "tests" / "focused.py"
                            ),
                        },
                        {
                            "path": "tests/real.py",
                            "fingerprint": vdd_accept.file_fingerprint(
                                source / "tests" / "real.py"
                            ),
                        },
                    ]
                },
            }
            provenance = vdd_accept._capture_source_provenance(contract, source)

            bound = vdd_accept._bind_real_upstream_artifacts(
                contract,
                provenance,
                source_workspace=source,
            )
            self.assertEqual("symlink", bound[0]["git_type"])

    def test_source_provenance_binds_pinned_git_symlink_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (workspace / "candidate-target.txt").write_text("candidate\n", encoding="utf-8")
            (workspace / "candidate.txt").unlink()
            (workspace / "candidate.txt").symlink_to("candidate-target.txt")
            contract["scope"]["editable"].append("candidate-target.txt")
            contract["candidate_capabilities"]["writable_paths"].append(
                "candidate-target.txt"
            )
            contract["control_plane"]["candidate_artifacts"].append(
                "candidate-target.txt"
            )
            (source / "candidate-target.txt").write_text("candidate\n", encoding="utf-8")
            (source / "candidate.txt").symlink_to("candidate-target.txt")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt", "candidate-target.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)

            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                source_workspace=source,
                signing_key=b"control-plane-secret",
                run_id="run-source-symlink",
            )
            source_artifact = next(
                item
                for item in attestation["control_plane"]["source_provenance"][
                    "candidate_artifacts"
                ]
                if item["path"] == "candidate.txt"
            )
            self.assertEqual("symlink", source_artifact["git_type"])
            vdd_accept.verify_attestation_bundle(
                attestation,
                contract,
                b"control-plane-secret",
                source_workspace=source,
            )

    def test_source_provenance_rejects_symlink_without_declared_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "candidate-workspace"
            source = root / "upstream-checkout"
            workspace.mkdir()
            source.mkdir()
            (workspace / "candidate-target.txt").write_text("candidate\n", encoding="utf-8")
            (workspace / "candidate-link.txt").symlink_to("candidate-target.txt")
            (source / "candidate-target.txt").write_text("candidate\n", encoding="utf-8")
            (source / "candidate-link.txt").symlink_to("candidate-target.txt")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(
                ["git", "add", "candidate-link.txt", "candidate-target.txt"],
                cwd=source,
                check=True,
            )
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract = {
                "source_provenance": {
                    "repository": "https://example.invalid/pinned-source.git",
                    "revision": revision,
                    "require_clean": True,
                }
            }
            provenance = vdd_accept._capture_source_provenance(contract, source)
            candidate_snapshot = [
                {
                    "path": "candidate-link.txt",
                    "fingerprint": vdd_accept._filesystem_entry_fingerprint(
                        workspace / "candidate-link.txt"
                    ),
                }
            ]
            with self.assertRaisesRegex(ValueError, "symlink target must be separately declared"):
                vdd_accept._bind_source_candidate_artifacts(
                    provenance,
                    source_workspace=source,
                    candidate_snapshot=candidate_snapshot,
                    candidate_workspace=workspace,
                )

    def test_real_upstream_symlink_requires_protected_target_closure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "upstream-checkout"
            source.mkdir()
            (source / "tests").mkdir()
            (source / "tests" / "real.py").write_text("test contents\n", encoding="utf-8")
            (source / "tests" / "focused.py").symlink_to("real.py")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "tests/real.py", "tests/focused.py"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"], cwd=source, check=True)
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            contract = {
                "source_provenance": {
                    "repository": "https://example.invalid/pinned-source.git",
                    "revision": revision,
                    "require_clean": True,
                },
                "real_upstream_workflow": {
                    "focused_artifacts": ["tests/focused.py"],
                    "broad_artifacts": ["tests/focused.py"],
                },
                "control_plane": {
                    "protected_assets": [
                        {
                            "path": "tests/focused.py",
                            "fingerprint": vdd_accept._filesystem_entry_fingerprint(
                                source / "tests" / "focused.py"
                            ),
                        }
                    ]
                },
            }
            provenance = vdd_accept._capture_source_provenance(contract, source)
            with self.assertRaisesRegex(ValueError, "symlink target must be declared in workflow"):
                vdd_accept._bind_real_upstream_artifacts(
                    contract,
                    provenance,
                    source_workspace=source,
                )

    def test_issue_captures_output_isolation_from_the_executed_boundary(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as snapshot_tmp, tempfile.TemporaryDirectory() as output_tmp:
            source = Path(source_tmp)
            snapshot = Path(snapshot_tmp)
            output_directory = Path(output_tmp)
            runner = snapshot / "runner.py"
            runner.write_text("raise SystemExit(0)\n", encoding="utf-8")
            observed = []

            def run_step(argv, **kwargs):
                observed.append((argv, kwargs))
                return subprocess.CompletedProcess(argv, 0, b"stdout", b"stderr")

            plan = [{
                "id": "CHECK",
                "display": "check",
                "argv": [sys.executable, "runner.py"],
                "expected_exit_code": 0,
                "result": "pass",
                "timeout_seconds": 1,
                "write_paths": [],
                "artifact_refs": [],
                "claim_ids": [],
                "defeater_ids": [],
            }]
            with mock.patch.object(vdd_accept, "_run_isolated_step", side_effect=run_step), mock.patch.object(
                vdd_accept, "_isolation_capture", return_value={
                    "provider": "test-isolation",
                    "policy_format": "test-policy",
                    "policy_bytes": b"tested-boundary",
                    "executable_fingerprint": vdd_accept.file_fingerprint(
                        Path(sys.executable).resolve()
                    ),
                }
            ):
                records = vdd_accept._execute_plan(
                    plan,
                    snapshot,
                    {"PATH": os.environ["PATH"]},
                    source_workspace=source,
                    nonfatal_step_ids=set(),
                    allowed_outputs=[],
                    candidate_paths=[],
                    readable_protected_paths=["runner.py"],
                    output_directory=output_directory,
                )
            self.assertEqual(1, len(observed))
            capture = records[0]["output_capture"]
            self.assertEqual("test-isolation", capture["isolation"]["provider"])
            self.assertEqual(
                b"tested-boundary",
                (output_directory / capture["isolation"]["path"]).read_bytes(),
            )

    def test_execute_plan_reuses_one_runtime_root_snapshot(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as snapshot_tmp:
            source = Path(source_tmp)
            snapshot = Path(snapshot_tmp)
            plan = [
                {
                    "id": f"CHECK-{index}",
                    "display": "check",
                    "argv": [sys.executable],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 1,
                    "write_paths": [],
                    "artifact_refs": [],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
                for index in range(2)
            ]
            observed_roots: list[list[Path] | None] = []

            def run_step(argv, **kwargs):
                observed_roots.append(kwargs.get("runtime_roots"))
                return subprocess.CompletedProcess(argv, 0, b"", b"")

            with mock.patch.object(
                vdd_accept,
                "_runtime_read_roots",
                return_value=[Path(sys.prefix)],
            ) as discover, mock.patch.object(
                vdd_accept,
                "_run_isolated_step",
                side_effect=run_step,
            ):
                records = vdd_accept._execute_plan(
                    plan,
                    snapshot,
                    {},
                    source_workspace=source,
                    nonfatal_step_ids=set(),
                    allowed_outputs=[],
                    candidate_paths=[],
                    readable_protected_paths=[],
                )
            self.assertEqual(2, len(records))
            self.assertEqual(1, discover.call_count)
            self.assertEqual(
                [[Path(sys.prefix)], [Path(sys.prefix)]],
                observed_roots,
            )

    def test_issue_rejects_output_directory_inside_candidate_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            with self.assertRaisesRegex(ValueError, "output directory overlaps workspace"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-output-inside-workspace",
                    output_directory=workspace / "retained-evidence",
                )

    def test_issue_rejects_workspace_race_during_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            original_copy = vdd_accept._copy_workspace_snapshot

            def racing_copy(source, destination, **kwargs):
                (Path(source) / "late.py").write_text("late\n", encoding="utf-8")
                return original_copy(source, destination, **kwargs)

            with mock.patch.object(
                vdd_accept,
                "_copy_workspace_snapshot",
                side_effect=racing_copy,
            ):
                with self.assertRaisesRegex(ValueError, "workspace changed"):
                    vdd_accept.issue_attestation(
                        contract,
                        proposal,
                        workspace=workspace,
                        signing_key=b"control-plane-secret",
                        run_id="run-copy-race",
                    )

    def test_snapshot_remaps_absolute_workspace_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            runner = workspace / "runner.py"
            for step in contract["control_plane"]["execution_plan"]:
                step["argv"][1] = str(runner)
            contract["environment"]["digest"] = vdd_accept.derive_environment_identity(
                {"PATH": os.environ["PATH"]},
                contract["control_plane"]["execution_plan"],
                workspace,
            )["digest"]
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-absolute-snapshot-path",
            )
            self.assertEqual("accepted", attestation["status"])

    def test_snapshot_remap_preserves_lexical_workspace_symlink(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as snapshot_tmp:
            source = Path(source_tmp)
            snapshot = Path(snapshot_tmp)
            (source / "bin").mkdir()
            (source / "lib").mkdir()
            (source / "lib" / "tool.py").write_text("VALUE = 1\n", encoding="utf-8")
            (source / "bin" / "tool.py").symlink_to("../lib/tool.py")
            normalized = vdd_accept._snapshot_argv(
                [sys.executable, str(source / "bin" / "tool.py")],
                source,
                snapshot,
            )
            self.assertEqual(str(snapshot.resolve() / "bin" / "tool.py"), normalized[1])

    def test_file_fingerprint_binds_mode_and_manifest_binds_directory_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            directory = workspace / "bin"
            directory.mkdir()
            executable = directory / "check"
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            file_before = vdd_accept.file_fingerprint(executable)
            manifest_before = vdd_accept._workspace_manifest(workspace)
            executable.chmod(0o755)
            file_after = vdd_accept.file_fingerprint(executable)
            self.assertNotEqual(file_before, file_after)
            directory.chmod(0o700)
            manifest_after = vdd_accept._workspace_manifest(workspace)
            self.assertNotEqual(manifest_before, manifest_after)

    def test_workspace_manifest_does_not_use_path_based_recursive_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "candidate.py").write_text("VALUE = 1\n", encoding="utf-8")
            with mock.patch.object(
                Path,
                "rglob",
                side_effect=AssertionError("workspace manifest must stay descriptor-rooted"),
            ):
                manifest = vdd_accept._workspace_manifest(workspace)
            self.assertIn("candidate.py", manifest)

    def test_workspace_manifest_does_not_double_close_a_transferred_file_descriptor(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "candidate.py").write_text("VALUE = 1\n", encoding="utf-8")
            replacement_fd: int | None = None

            def fail_after_consuming(file_fd, _status):
                nonlocal replacement_fd
                os.close(file_fd)
                replacement_fd = os.open(os.devnull, os.O_RDONLY)
                self.assertEqual(file_fd, replacement_fd)
                raise ValueError("synthetic hashing failure")

            with mock.patch.object(
                vdd_accept,
                "_hash_regular_file_fd",
                side_effect=fail_after_consuming,
            ):
                with self.assertRaisesRegex(ValueError, "synthetic hashing failure"):
                    vdd_accept._workspace_manifest(workspace)
            assert replacement_fd is not None
            try:
                os.fstat(replacement_fd)
            finally:
                try:
                    os.close(replacement_fd)
                except OSError:
                    pass

    @unittest.skipUnless(hasattr(os, "mkfifo"), "requires POSIX FIFO support")
    def test_source_observation_rejects_special_files_before_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fifo = root / "candidate"
            os.mkfifo(fifo)
            root_fd = os.open(root, os.O_RDONLY)
            try:
                with mock.patch.object(
                    vdd_accept.os,
                    "open",
                    side_effect=AssertionError("special files must not be opened"),
                ):
                    with self.assertRaisesRegex(ValueError, "regular file or symlink"):
                        vdd_accept._observe_artifact_at(
                            root_fd,
                            fifo.name,
                            fifo.name,
                        )
            finally:
                os.close(root_fd)

    def test_candidate_snapshot_rejects_a_symlink_ancestor(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            real = workspace / "real"
            real.mkdir()
            (real / "candidate.py").write_text("VALUE = 1\n", encoding="utf-8")
            (workspace / "linked").symlink_to("real")
            contract = {
                "control_plane": {
                    "candidate_artifacts": ["linked/candidate.py"],
                }
            }
            with self.assertRaisesRegex(ValueError, "symlink ancestor"):
                vdd_accept._candidate_snapshot(contract, workspace)

    def test_candidate_snapshot_binds_ancestor_modes_and_symlink_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "bin").mkdir()
            (workspace / "lib").mkdir()
            for name in ("a.py", "b.py"):
                (workspace / "lib" / name).write_text("VALUE = 1\n", encoding="utf-8")
            link = workspace / "bin" / "tool.py"
            link.symlink_to("../lib/a.py")
            contract = {
                "control_plane": {
                    "candidate_artifacts": [
                        "bin/tool.py",
                        "lib/a.py",
                        "lib/b.py",
                    ]
                }
            }
            initial = vdd_accept._candidate_snapshot(contract, workspace)
            (workspace / "bin").chmod(0o700)
            self.assertNotEqual(
                initial,
                vdd_accept._candidate_snapshot(contract, workspace),
            )
            (workspace / "bin").chmod(0o755)
            link.unlink()
            link.symlink_to("../lib/b.py")
            self.assertNotEqual(
                initial,
                vdd_accept._candidate_snapshot(contract, workspace),
            )

    def test_fresh_stability_requires_distinct_declared_trial_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            qualification = contract["oracles"][0]["qualification"]
            qualification["restore_command"] = qualification["known_good_command"]
            qualification["required_no_change_trials"] = 1
            qualification["stability_required"] = True
            contract["control_plane"]["execution_plan"][2]["display"] = qualification[
                "known_good_command"
            ]
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "stability_command_ids"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-no-stability-role",
                )

    def test_fresh_stability_command_cannot_overlap_discovery_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            qualification = contract["oracles"][0]["qualification"]
            qualification["known_good_command"] = "discover protected tests"
            qualification["stability_required"] = True
            qualification["stability_command_ids"] = ["DISCOVERY"]
            qualification["required_no_change_trials"] = 1
            qualification["max_flake_rate"] = 1.0
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(
                contract
            )
            with self.assertRaisesRegex(
                ValueError, "overlap non-stability control-plane roles"
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-overlapping-stability-discovery",
                )
            self.assertFalse((workspace / "discovery.json").exists())

    def test_fresh_stability_records_failures_within_flake_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            qualification = contract["oracles"][0]["qualification"]
            stability_ids = [f"Q-STABILITY-{index}" for index in range(1, 5)]
            qualification["stability_required"] = True
            qualification["stability_command_ids"] = stability_ids
            qualification["required_no_change_trials"] = 4
            qualification["max_flake_rate"] = 0.25
            stability_steps = []
            for command_id, mode in zip(
                stability_ids,
                ["good", "good", "bad", "good"],
                strict=True,
            ):
                stability_steps.append(
                    {
                        "id": command_id,
                        "display": qualification["known_good_command"],
                        "argv": [sys.executable, "runner.py", mode],
                        "expected_exit_code": 0,
                        "result": "pass",
                        "write_paths": [],
                        "artifact_refs": [],
                        "claim_ids": [],
                        "defeater_ids": [],
                    }
                )
            contract["control_plane"]["execution_plan"][3:3] = stability_steps
            contract["environment"]["digest"] = vdd_accept.derive_environment_identity(
                {"PATH": os.environ["PATH"]},
                contract["control_plane"]["execution_plan"],
                workspace,
            )["digest"]
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-flaky-qualification",
            )
            self.assertEqual("accepted", attestation["status"])
            self.assertEqual(4, attestation["oracles"][0]["no_change_trials"])
            self.assertEqual(0.25, attestation["oracles"][0]["flake_rate"])
            results = {
                command["id"]: command["result"]
                for command in attestation["commands"]
                if command["id"] in stability_ids
            }
            self.assertEqual(1, list(results.values()).count("fail"))

    def test_environment_identity_resolves_relative_executable_in_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            executable = workspace / "check"
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            identity = vdd_accept.derive_environment_identity(
                {},
                [{"argv": ["./check"]}],
                workspace,
            )
            self.assertEqual(
                str(executable.resolve()),
                identity["details"]["executables"]["./check"]["path"],
            )
            runtime = identity["details"]["runtime"]
            expected_runtime = vdd_accept.runtime_platform_identity()
            self.assertEqual(expected_runtime["system"], runtime["system"])
            self.assertEqual(expected_runtime["machine"], runtime["machine"])
            self.assertEqual(expected_runtime["platform_id"], runtime["platform_id"])
            self.assertEqual(
                f"{expected_runtime['system']}-{expected_runtime['machine']}",
                runtime["platform_id"],
            )
            with self.assertRaisesRegex(ValueError, "allowlisted PATH"):
                vdd_accept.derive_environment_identity(
                    {},
                    [{"argv": ["python3"]}],
                    workspace,
                )

    def test_issue_rejects_actual_environment_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            original_path = os.environ["PATH"]
            os.environ["PATH"] = original_path + os.pathsep + "/environment-drift"
            try:
                with self.assertRaisesRegex(ValueError, "environment identity differs"):
                    vdd_accept.issue_attestation(
                        contract,
                        proposal,
                        workspace=workspace,
                        signing_key=b"control-plane-secret",
                        run_id="run-environment-drift",
                    )
            finally:
                os.environ["PATH"] = original_path

    def test_execute_plan_rejects_executable_drift_after_preflight(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as snapshot_tmp:
            source = Path(source_tmp)
            snapshot = Path(snapshot_tmp)
            executable = Path(source_tmp).parent / (
                f"vdd-external-executable-{os.getpid()}-{time.time_ns()}"
            )
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(0o755)
            plan = [
                {
                    "id": "CHECK",
                    "display": "check",
                    "argv": [str(executable)],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 1,
                    "write_paths": [],
                    "artifact_refs": [],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ]
            identities = vdd_accept.derive_environment_identity(
                {},
                plan,
                source,
            )["details"]["executables"]
            executable.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
            try:
                with mock.patch.object(
                    vdd_accept,
                    "_run_isolated_step",
                    side_effect=AssertionError("drifted executable must not run"),
                ):
                    with self.assertRaisesRegex(
                        ValueError,
                        "executable identity changed",
                    ):
                        vdd_accept._execute_plan(
                            plan,
                            snapshot,
                            {},
                            source_workspace=source,
                            nonfatal_step_ids=set(),
                            allowed_outputs=[],
                            candidate_paths=[],
                            readable_protected_paths=[],
                            executable_identities=identities,
                        )
            finally:
                executable.unlink(missing_ok=True)

    def test_issue_rejects_schema_invalid_proposal(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            proposal["release"] = "schema-invalid"
            with self.assertRaisesRegex(ValueError, "evidence schema validation failed"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-schema-invalid",
                )
    def test_improvement_uses_protected_metric_output_not_proposal_samples(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            metric_result = {
                "name": "latency",
                "direction": "lower",
                "baseline_samples": [100, 101, 99],
                "candidate_samples": [99, 100, 98],
                "noise_band": 5.0,
                "minimum_meaningful_change": 10.0,
                "result": "statistical_inconclusive",
            }
            metric_step = {
                "id": "METRIC",
                "display": "measure candidate",
                "argv": [
                    sys.executable,
                    "runner.py",
                    "metric",
                ],
                "expected_exit_code": 0,
                "result": "pass",
                "write_paths": ["metric.json"],
                "artifact_refs": ["metric.json"],
                "claim_ids": ["C-SLUG"],
                "defeater_ids": [],
            }
            # Extend protected runner to emit metric result.
            runner = workspace / "runner.py"
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    "elif mode == 'bad':\n",
                    "elif mode == 'metric':\n"
                    f"    pathlib.Path('metric.json').write_text({json.dumps(json.dumps(metric_result))})\n"
                    "elif mode == 'bad':\n",
                ),
                encoding="utf-8",
            )
            contract["control_plane"]["protected_assets"] = [
                item
                if item["path"] != "runner.py"
                else {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                }
                for item in contract["control_plane"]["protected_assets"]
            ]
            contract["control_plane"]["execution_plan"].append(metric_step)
            contract["control_plane"]["allowed_output_paths"].append("metric.json")
            contract["control_plane"]["metric_result"] = {
                "command_id": "METRIC",
                "result_path": "metric.json",
                "producer_path": "runner.py",
            }
            contract["mode"] = "improvement"
            contract["oracles"][0]["type"] = "benchmark"
            contract["baseline"] = {
                "semantic_red_command": None,
                "reference_green_command": None,
                "semantic_green_command": "check candidate",
                "hard_constraint_commands": ["check candidate"],
                "metric": {
                    "name": "latency",
                    "direction": "lower",
                    "baseline_command": "measure candidate",
                    "runs": 3,
                    "noise_band": 5.0,
                    "minimum_improvement": 10.0,
                },
            }
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            actual_environment = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = actual_environment["digest"]
            proposal["mode"] = "improvement"
            proposal["environment"] = actual_environment
            proposal["mode_evidence"] = {
                "semantic_green_commands": ["CHECK"],
                "hard_constraint_commands": ["CHECK"],
                "fast_path_command": "CHECK",
                "metric_command": "METRIC",
                "metric_result": {
                    **metric_result,
                    "candidate_samples": [80, 81, 79],
                    "result": "improved",
                },
            }
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError,
                "accepted Improvement evidence requires an improved metric result",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-protected-metric",
                )


    def test_verify_rejects_expired_accepted_residual(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["defeaters"][0]["status"] = "accepted_residual"
            contract["defeaters"][0]["risk_acceptance"] = {
                "owner": "risk-owner",
                "stages": ["merge"],
                "expires_at": "2099-12-31T00:00:00Z",
                "invalidated_by": ["contract change"],
                "rationale": "Time-bounded merge acceptance.",
            }
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            proposal["defeater_results"][0]["status"] = "accepted_residual"
            proposal["defeater_results"][0]["evidence_refs"] = []
            proposal["residual_risks"] = [
                {
                    "defeater_id": contract["defeaters"][0]["id"],
                    "stage": "merge",
                    "owner": "risk-owner",
                    "rationale": "Time-bounded merge acceptance.",
                    "expires_at": "2099-12-31T00:00:00Z",
                    "decision_ref": "RISK-DECISION-1",
                    "invalidated_by": ["contract change"],
                }
            ]
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-residual-expiry",
            )
            with self.assertRaisesRegex(ValueError, "expired before verification"):
                vdd_accept.verify_attestation_bundle(
                    attestation,
                    contract,
                    b"control-plane-secret",
                    verification_time=datetime(2100, 1, 1, tzinfo=timezone.utc),
                )

    def test_cli_issues_and_verifies_attestation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            contract_path = root / "contract.json"
            proposal_path = root / "proposal.json"
            key_path = root / "signing.key"
            attestation_path = root / "attestation.json"
            contract_path.write_text(json.dumps(contract), encoding="utf-8")
            proposal_path.write_text(json.dumps(proposal), encoding="utf-8")
            key_path.write_bytes(b"control-plane-secret")

            issued = subprocess.run(
                [
                    sys.executable,
                    str(TOOLS / "vdd_accept.py"),
                    "issue",
                    "--contract",
                    str(contract_path),
                    "--proposal",
                    str(proposal_path),
                    "--workspace",
                    str(workspace),
                    "--key-file",
                    str(key_path),
                    "--run-id",
                    "cli-run",
                    "--output",
                    str(attestation_path),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertEqual(0, issued.returncode, issued.stderr)
            verified = subprocess.run(
                [
                    sys.executable,
                    str(TOOLS / "vdd_accept.py"),
                    "verify",
                    "--contract",
                    str(contract_path),
                    "--attestation",
                    str(attestation_path),
                    "--key-file",
                    str(key_path),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertEqual(0, verified.returncode, verified.stderr)
            self.assertIn("VERIFIED", verified.stdout)

    def test_cli_rejects_attestation_output_inside_source_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            source = root / "source"
            workspace.mkdir()
            source.mkdir()
            contract, proposal, _ = self.make_case(workspace)
            (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "vdd@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "VDD Test"], cwd=source, check=True)
            subprocess.run(["git", "add", "candidate.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "source fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.invalid/pinned-source.git"],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            contract["risk_profile"] = "standard"
            proposal["risk_profile"] = "standard"
            contract["source_provenance"] = {
                "repository": "https://example.invalid/pinned-source.git",
                "revision": revision,
                "require_clean": True,
            }
            contract["environment"]["fingerprint_fields"].append("source provenance")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            contract_path = root / "contract.json"
            proposal_path = root / "proposal.json"
            key_path = root / "signing.key"
            contract_path.write_text(json.dumps(contract), encoding="utf-8")
            proposal_path.write_text(json.dumps(proposal), encoding="utf-8")
            key_path.write_bytes(b"control-plane-secret")

            issued = subprocess.run(
                [
                    sys.executable,
                    str(TOOLS / "vdd_accept.py"),
                    "issue",
                    "--contract",
                    str(contract_path),
                    "--proposal",
                    str(proposal_path),
                    "--workspace",
                    str(workspace),
                    "--source-workspace",
                    str(source),
                    "--key-file",
                    str(key_path),
                    "--run-id",
                    "cli-source-output",
                    "--output",
                    str(source / "attestation.json"),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertEqual(2, issued.returncode)
            self.assertIn("attestation output overlaps source workspace", issued.stderr)
            self.assertFalse((source / "attestation.json").exists())

    def test_issue_rejects_modified_protected_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, protected = self.make_case(workspace)
            protected.write_text("candidate tampered\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "protected asset fingerprint differs"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-2",
                )


    def test_issue_rejects_candidate_symlink_to_protected_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, protected = self.make_case(workspace)
            candidate = workspace / "candidate.txt"
            candidate.unlink()
            candidate.symlink_to(protected.name)
            with self.assertRaisesRegex(ValueError, "must be disjoint"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-symlink-alias",
                )

    def test_issue_rejects_protected_asset_changed_during_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, protected = self.make_case(workspace)
            contract["control_plane"]["execution_plan"][-1]["argv"][-1] = "mutate-protected"
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError,
                "changed during acceptance|exited 1|protected|isolation|write",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-mutating-protected",
                )
            self.assertEqual("protected truth\n", protected.read_text(encoding="utf-8"))

    def test_issue_rejects_transient_protected_aba_during_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, protected = self.make_case(workspace)
            runner = workspace / "runner.py"
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    "elif mode == 'mutate-protected':\n"
                    "    pathlib.Path('protected.txt').write_text('changed during acceptance\\n')\n",
                    "elif mode == 'mutate-protected':\n"
                    "    pathlib.Path('protected.txt').write_text('changed during acceptance\\n')\n"
                    "elif mode == 'aba-protected':\n"
                    "    path = pathlib.Path('protected.txt')\n"
                    "    original = path.read_text()\n"
                    "    path.write_text('weakened during acceptance\\n')\n"
                    "    path.write_text(original)\n",
                ),
                encoding="utf-8",
            )
            contract["control_plane"]["protected_assets"] = [
                {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                },
                {
                    "path": "protected.txt",
                    "fingerprint": vdd_accept.file_fingerprint(protected),
                },
            ]
            contract["control_plane"]["execution_plan"][-1]["argv"][-1] = "aba-protected"
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            contract["environment"]["digest"] = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )["digest"]
            proposal["environment"] = copy.deepcopy(
                vdd_accept.derive_environment_identity(
                    execution_environment,
                    contract["control_plane"]["execution_plan"],
                    workspace,
                )
            )
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError,
                "protected|isolation|sandbox|read-only|write|exited",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-aba-protected",
                )
            self.assertEqual("protected truth\n", protected.read_text(encoding="utf-8"))


    def test_issue_rejects_candidate_artifact_changed_during_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["control_plane"]["execution_plan"][-1]["argv"][-1] = "mutate-candidate"
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError, "acceptance command CHECK exited|candidate artifact changed during acceptance"
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-mutating-candidate",
                )
            self.assertEqual(
                "candidate\n",
                (workspace / "candidate.txt").read_text(encoding="utf-8"),
            )

    def test_issue_rejects_stale_discovery_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            (workspace / "discovery.json").write_text(
                json.dumps(proposal["test_discovery"]),
                encoding="utf-8",
            )
            contract["control_plane"]["execution_plan"][3]["argv"][-1] = "good"
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "discovery result missing|discovery result is missing"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-stale-discovery",
                )

    def test_issue_rejects_undeclared_workspace_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            (workspace / "undeclared.txt").write_text("hidden scope\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "lack candidate/protected scope"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-undeclared",
                )

    def test_invalid_later_plan_step_is_rejected_before_any_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            marker = workspace / "external-marker.txt"
            contract["control_plane"]["execution_plan"][0]["argv"] = [
                sys.executable,
                "-c",
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
            ]
            contract["control_plane"]["execution_plan"].append(
                {
                    "id": "INVALID-LATE",
                    "display": "invalid later step",
                    "argv": [],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [],
                    "artifact_refs": [],
                }
            )
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "non-empty"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-invalid-plan",
                )
            self.assertFalse(marker.exists())

    def test_release_requires_and_resolves_authenticated_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["gates"]["release"] = "check candidate"
            contract["roles"]["release_owner"] = "release-owner"
            # Keep merge issuance free of release_result; attach only for release stage.
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            parent = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="merge-run",
            )
            release_payload = {
                "canary_or_shadow": "canary-run-7",
                "thresholds_passed": True,
                "rollback_trigger": "error-rate > 1%",
                "release_owner": contract["roles"]["release_owner"],
            }
            runner = workspace / "runner.py"
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    "elif mode == 'bad':\n",
                    "elif mode == 'release':\n"
                    f"    pathlib.Path('release.json').write_text({json.dumps(json.dumps(release_payload))})\n"
                    "elif mode == 'bad':\n",
                ),
                encoding="utf-8",
            )
            contract["control_plane"]["protected_assets"] = [
                item
                if item["path"] != "runner.py"
                else {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                }
                for item in contract["control_plane"]["protected_assets"]
            ]
            contract["control_plane"]["allowed_output_paths"].append("release.json")
            contract["control_plane"]["execution_plan"].append(
                {
                    "id": "RELEASE",
                    "display": "release canary",
                    "argv": [sys.executable, "runner.py", "release"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": ["release.json"],
                    "artifact_refs": ["release.json"],
                }
            )
            contract["control_plane"]["release_result"] = {
                "command_id": "RELEASE",
                "result_path": "release.json",
                "producer_path": "runner.py",
            }
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env_identity = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env_identity["digest"]
            proposal["environment"] = copy.deepcopy(env_identity)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            # Refresh parent under release-capable contract identity.
            parent = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="merge-run-refresh",
            )

            release = copy.deepcopy(proposal)
            release["stage"] = "release"
            release["merge"]["rollback_exercised"] = True
            release["release"] = {
                "canary_or_shadow": "canary-run-7",
                "thresholds_passed": True,
                "rollback_trigger": "error-rate > 1%",
                "release_owner": contract["roles"]["release_owner"],
            }
            release["parent_attestation"] = {
                "attestation_id": "fabricated",
                "digest": "sha256:" + "0" * 64,
                "stage": "merge",
                "status": "accepted",
                "contract_fingerprint": release["contract"]["fingerprint"],
                "candidate_revision": release["candidate"]["revision"],
            }
            with self.assertRaisesRegex(ValueError, "requires an authenticated parent"):
                vdd_accept.issue_attestation(
                    contract,
                    release,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="release-without-parent",
                )
            attestation = vdd_accept.issue_attestation(
                contract,
                release,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="release-run",
                parent_attestation=parent,
            )
            self.assertEqual(
                vdd_accept.attestation_digest(parent),
                attestation["parent_attestation"]["digest"],
            )
            with self.assertRaisesRegex(ValueError, "requires an authenticated parent"):
                vdd_accept.verify_attestation_bundle(
                    attestation,
                    contract,
                    b"control-plane-secret",
                )
            vdd_accept.verify_attestation_bundle(
                attestation,
                contract,
                b"control-plane-secret",
                parent_attestation=parent,
            )

    def test_reused_qualification_requires_authenticated_prior_attestation(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            prior = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="qualification-run",
            )
            oracle = contract["oracles"][0]
            qualification_basis = {
                key: value
                for key, value in oracle["qualification"].items()
                if key != "status"
            }
            oracle["qualification"] = {
                "status": "reused",
                "prior_attestation_id": prior["attestation_id"],
                "prior_attestation_digest": vdd_accept.attestation_digest(prior),
                "qualified_fingerprint": oracle["fingerprint"],
                "covered_defeater_ids": ["D-REPEATED-SEPARATOR"],
                "qualification_basis": qualification_basis,
                "qualification_contract_fingerprint": prior["oracles"][0][
                    "qualification_contract_fingerprint"
                ],
                "stability_required": False,
                "required_no_change_trials": 0,
                "max_flake_rate": 0.0,
            }
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            proposal["oracles"][0]["no_change_trials"] = 99
            proposal["oracles"][0]["flake_rate"] = 0.5
            with self.assertRaisesRegex(ValueError, "requires prior attestation"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="reuse-without-prior",
                )
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="reuse-run",
                qualification_attestations=[prior],
            )
            observed = attestation["oracles"][0]
            self.assertEqual(prior["attestation_id"], observed["qualification_attestation_id"])
            self.assertEqual(
                vdd_accept.attestation_digest(prior),
                observed["qualification_attestation_digest"],
            )
            self.assertEqual(0, observed["no_change_trials"])
            self.assertEqual(0.0, observed["flake_rate"])
            with self.assertRaisesRegex(ValueError, "requires prior attestation"):
                vdd_accept.verify_attestation_bundle(
                    attestation,
                    contract,
                    b"control-plane-secret",
                )
            vdd_accept.verify_attestation_bundle(
                attestation,
                contract,
                b"control-plane-secret",
                qualification_attestations=[prior],
            )
            contract["oracles"][0]["qualification"]["stability_required"] = True
            contract["oracles"][0]["qualification"]["required_no_change_trials"] = 1
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "lacks required no-change trials"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="reuse-insufficient-trials",
                    qualification_attestations=[prior],
                )

    def test_reused_qualification_rejects_control_plane_semantic_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            prior = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="qualification-run-control-plane-drift",
            )
            oracle = contract["oracles"][0]
            fresh_qualification = copy.deepcopy(oracle["qualification"])
            oracle["qualification"] = {
                "status": "reused",
                "prior_attestation_id": prior["attestation_id"],
                "prior_attestation_digest": vdd_accept.attestation_digest(prior),
                "qualified_fingerprint": oracle["fingerprint"],
                "covered_defeater_ids": ["D-REPEATED-SEPARATOR"],
                "qualification_basis": {
                    key: value
                    for key, value in fresh_qualification.items()
                    if key != "status"
                },
                "qualification_contract_fingerprint": prior["oracles"][0][
                    "qualification_contract_fingerprint"
                ],
                "stability_required": False,
                "required_no_change_trials": 0,
                "max_flake_rate": 0.0,
            }
            contract["control_plane"]["execution_plan"][0]["argv"][-1] = "check"
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError,
                "qualification_contract_fingerprint differs from current semantics",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="reuse-control-plane-drift",
                    qualification_attestations=[prior],
                )

    def test_issue_rejects_wrong_reason_expected_reject_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            # Crash/setup exit 1 without the Contract expected_rejection signal.
            contract["control_plane"]["execution_plan"][1]["argv"][-1] = "crash-bad"
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            contract["environment"]["digest"] = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )["digest"]
            proposal["environment"] = copy.deepcopy(
                vdd_accept.derive_environment_identity(
                    execution_environment,
                    contract["control_plane"]["execution_plan"],
                    workspace,
                )
            )
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError,
                "missing expected rejection signal|exited 1",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-wrong-reason-reject",
                )

    def test_issue_rejects_execution_plan_outside_allowed_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["candidate_capabilities"]["allowed_commands"] = ["not-the-runner"]
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "outside candidate allowed_commands"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-command-policy",
                )

    def test_issue_rejects_execution_plan_matching_denied_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["candidate_capabilities"]["allowed_commands"] = [sys.executable]
            contract["candidate_capabilities"]["denied_commands"] = [
                f"{sys.executable} runner.py bad"
            ]
            contract["control_plane"]["execution_plan"][1]["argv"][1] = "./runner.py"
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            environment_identity = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = environment_identity["digest"]
            proposal["environment"] = copy.deepcopy(environment_identity)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "matches a denied candidate command"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-denied-command-policy",
                )

    def test_issue_rejects_relative_operand_escaping_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["control_plane"]["execution_plan"][-1]["argv"].append(
                "../undeclared-host-input.txt"
            )
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            environment_identity = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = environment_identity["digest"]
            proposal["environment"] = copy.deepcopy(environment_identity)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "relative operand escapes workspace"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-relative-operand-escape",
                )

    def test_snapshot_rejects_relative_operand_resolving_to_source_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            snapshot = root / "snapshot"
            source.mkdir()
            snapshot.mkdir()
            (source / "mutable-input.txt").write_text("mutable\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "relative operand escapes workspace"):
                vdd_accept._snapshot_argv(
                    [sys.executable, "../source/mutable-input.txt"],
                    source,
                    snapshot,
                )

    def test_snapshot_rejects_external_paths_in_common_option_syntaxes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            snapshot = root / "snapshot"
            source.mkdir()
            snapshot.mkdir()
            (source / "mutable-input.txt").write_text("mutable\n", encoding="utf-8")
            for argument in (
                "--config=../source/mutable-input.txt",
                "-I../source/mutable-input.txt",
                "-r../source/mutable-input.txt",
                "-f../source/mutable-input.txt",
                "@../source/mutable-input.txt",
            ):
                with self.subTest(argument=argument):
                    with self.assertRaisesRegex(
                        ValueError,
                        "relative operand escapes workspace|unsupported path-bearing option",
                    ):
                        vdd_accept._snapshot_argv(
                            [sys.executable, argument],
                            source,
                            snapshot,
                        )

    def test_command_policy_does_not_normalize_semantic_slash_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            self.assertFalse(
                vdd_accept._argv_matches_pattern(
                    [sys.executable, "x/../safe"],
                    (sys.executable, "safe"),
                    workspace=workspace,
                    environment={"PATH": os.environ["PATH"]},
                )
            )

    def test_command_policy_resolves_bare_and_absolute_executable_spellings(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            executable = Path(sys.executable).resolve()
            environment = {"PATH": str(executable.parent)}
            self.assertTrue(
                vdd_accept._argv_matches_pattern(
                    [str(executable), "-c"],
                    (executable.name, "-c"),
                    workspace=workspace,
                    environment=environment,
                )
            )
            self.assertTrue(
                vdd_accept._argv_matches_pattern(
                    [executable.name, "-c"],
                    (str(executable), "-c"),
                    workspace=workspace,
                    environment=environment,
                )
            )

    def test_issue_rejects_allowed_output_inside_editable_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["scope"]["editable"].append("discovery.json")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "allowed output overlaps editable scope"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-editable-output",
                )

    def test_issue_rejects_candidate_discovery_producer(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            # Candidate-owned producer path must be rejected.
            contract["control_plane"]["discovery"]["producer_path"] = "candidate.txt"
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "producer_path must be a protected asset"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-candidate-producer",
                )

    def test_contract_requires_explicit_per_step_write_authority(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["control_plane"]["execution_plan"][3].pop("write_paths")
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "write_paths"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-missing-write-authority",
                )

    def test_issue_rejects_nonproducer_discovery_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            runner = workspace / "runner.py"
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    "if mode == 'discover':\n"
                    "    pathlib.Path('discovery.json').write_text(DISCOVERY)\n",
                    "if mode == 'discover':\n"
                    "    pathlib.Path('discovery.json').write_text(DISCOVERY)\n"
                    "elif mode == 'overwrite-discovery':\n"
                    "    pathlib.Path('discovery.json').write_text('{\"tampered\": true}')\n",
                ),
                encoding="utf-8",
            )
            contract["control_plane"]["protected_assets"] = [
                item
                if item["path"] != "runner.py"
                else {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                }
                for item in contract["control_plane"]["protected_assets"]
            ]
            contract["control_plane"]["execution_plan"][-1]["argv"][-1] = "overwrite-discovery"
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "acceptance command CHECK exited"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-overwrite-discovery",
                )


    def test_producer_capture_seals_malicious_step_id_inside_control_plane_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            result_path = workspace / "result.json"
            result_path.write_text('{"safe":true}\n', encoding="utf-8")
            escaped = workspace.parent / "escaped__result.json"
            plan = [
                {
                    "id": "../../escaped",
                    "display": "capture protected result",
                    "argv": [sys.executable, "runner.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 5,
                    "write_paths": ["result.json"],
                    "artifact_refs": ["result.json"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ]
            with mock.patch.object(
                vdd_accept,
                "_run_isolated_step",
                return_value=subprocess.CompletedProcess([], 0, b"", b""),
            ):
                records = vdd_accept._execute_plan(
                    plan,
                    workspace,
                    {"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
                    source_workspace=workspace,
                    nonfatal_step_ids=set(),
                    allowed_outputs=["result.json"],
                    candidate_paths=[],
                    readable_protected_paths=[],
                    producer_captures={
                        "../../escaped": {
                            "role": "discovery",
                            "result_path": "result.json",
                        }
                    },
                )
            sealed_path = records[0]["captured_result"]["sealed_path"]
            self.assertTrue(sealed_path.startswith(".vdd-accept-sealed/"))
            self.assertFalse(escaped.exists())

    def test_reused_qualification_rejects_fixture_or_environment_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            prior = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="qualification-run-drift",
            )
            oracle = contract["oracles"][0]
            qualification_basis = {
                key: value
                for key, value in oracle["qualification"].items()
                if key != "status"
            }
            oracle["qualification"] = {
                "status": "reused",
                "prior_attestation_id": prior["attestation_id"],
                "prior_attestation_digest": vdd_accept.attestation_digest(prior),
                "qualified_fingerprint": oracle["fingerprint"],
                "covered_defeater_ids": ["D-REPEATED-SEPARATOR"],
                "qualification_basis": qualification_basis,
                "qualification_contract_fingerprint": prior["oracles"][0][
                    "qualification_contract_fingerprint"
                ],
                "stability_required": False,
                "required_no_change_trials": 0,
                "max_flake_rate": 0.0,
            }
            # Fixture fingerprint drift.
            contract["fixtures"][0]["fingerprint"] = "sha256:" + "1" * 64
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(ValueError, "fixture fingerprints differ"):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="reuse-fixture-drift",
                    qualification_attestations=[prior],
                )
            # Restore fixtures, drift environment identity instead.
            contract["fixtures"][0]["fingerprint"] = prior["fixtures"][0]["fingerprint"]
            contract["environment"]["digest"] = "sha256:" + "2" * 64
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError,
                "environment identity differs",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="reuse-environment-drift",
                    qualification_attestations=[prior],
                )

    def test_acceptance_output_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            runner = workspace / "flood.py"
            runner.write_text(
                "import sys\n"
                f"sys.stdout.write('x' * ({vdd_accept.ACCEPTANCE_OUTPUT_LIMIT_BYTES} + 1))\n",
                encoding="utf-8",
            )
            try:
                with mock.patch.object(vdd_accept, "_sandbox_command", return_value=[sys.executable, str(runner)]):
                    with self.assertRaisesRegex(ValueError, "stdout exceeded bounded output limit"):
                        vdd_accept._run_isolated_step(
                            [sys.executable, str(runner)],
                            workspace=workspace,
                            environment={"PATH": os.environ["PATH"]},
                            timeout_seconds=5,
                            readable_files=[],
                            readable_dirs=[],
                            writable_files=[],
                            writable_dirs=[],
                        )
            finally:
                runner.unlink(missing_ok=True)

    def test_acceptance_output_preserves_bytes_drained_after_process_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            runner = workspace / "tail_output.py"
            runner.write_text(
                "import os\n"
                "os.write(1, b'trailing-stdout')\n"
                "os.write(2, b'trailing-stderr')\n",
                encoding="utf-8",
            )
            with mock.patch.object(
                vdd_accept,
                "_sandbox_command",
                return_value=[sys.executable, str(runner)],
            ), mock.patch.object(
                vdd_accept.select,
                "select",
                return_value=([], [], []),
            ):
                completed = vdd_accept._run_isolated_step(
                    [sys.executable, str(runner)],
                    workspace=workspace,
                    environment={"PATH": os.environ["PATH"]},
                    timeout_seconds=5,
                    readable_files=[],
                    readable_dirs=[],
                    writable_files=[],
                    writable_dirs=[],
                )
            self.assertEqual(b"trailing-stdout", completed.stdout)
            self.assertEqual(b"trailing-stderr", completed.stderr)

    def test_control_plane_cleanup_never_signals_a_reaped_sandbox(self):
        class ReapedProcess:
            pid = 404
            returncode = 0

            def kill(self):
                raise AssertionError("reaped direct child must not be signalled")

            def wait(self, *, timeout):
                raise AssertionError("reaped direct child must not be waited twice")

        with mock.patch.object(
            vdd_accept.os,
            "killpg",
            side_effect=AssertionError("reaped process group must not be signalled"),
        ):
            vdd_accept._terminate_owned_sandbox(ReapedProcess())

    def test_control_plane_step_does_not_scan_the_host_process_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            runner = workspace / "exit_zero.py"
            runner.write_text("raise SystemExit(0)\n", encoding="utf-8")
            with mock.patch.object(
                vdd_accept,
                "_sandbox_command",
                return_value=[sys.executable, str(runner)],
            ), mock.patch.object(
                vdd_accept.subprocess,
                "run",
                side_effect=AssertionError("control plane must not scan host processes"),
            ):
                completed = vdd_accept._run_isolated_step(
                    [sys.executable, str(runner)],
                    workspace=workspace,
                    environment={"PATH": os.environ["PATH"]},
                    timeout_seconds=5,
                    readable_files=[],
                    readable_dirs=[],
                    writable_files=[],
                    writable_dirs=[],
                )
            self.assertEqual(0, completed.returncode)

    def test_linux_sandbox_mounts_an_explicit_external_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            temp_root = root / "temp"
            temp_root.mkdir()
            executable = root / "external-tool"
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            executable.chmod(0o755)
            runtime_root = root / "runtime"
            runtime_root.mkdir()
            with mock.patch.object(vdd_accept.sys, "platform", "linux"), mock.patch.object(
                vdd_accept.shutil, "which", return_value="/usr/bin/bwrap"
            ), mock.patch.object(
                vdd_accept,
                "_runtime_read_roots",
                return_value=[runtime_root],
            ):
                command = vdd_accept._sandbox_command(
                    [str(executable)],
                    workspace=workspace,
                    readable_files=[],
                    readable_dirs=[],
                    writable_files=[],
                    writable_dirs=[],
                    temp_root=temp_root,
                )
            resolved_executable = str(executable.resolve())
            self.assertIn(
                ["--ro-bind", resolved_executable, resolved_executable],
                [command[index : index + 3] for index in range(len(command) - 2)],
            )
            self.assertEqual(resolved_executable, command[-1])

    def test_macos_sandbox_root_literal_is_not_recursive_host_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            temp_root = root / "temp"
            temp_root.mkdir()
            runtime_root = root / "runtime"
            runtime_root.mkdir()
            runtime_file = root / "runtime-file"
            runtime_file.write_text("runtime\n", encoding="utf-8")
            with mock.patch.object(vdd_accept.sys, "platform", "darwin"), mock.patch.object(
                vdd_accept.shutil, "which", return_value="/usr/bin/sandbox-exec"
            ), mock.patch.object(
                vdd_accept,
                "_runtime_read_roots",
                return_value=[runtime_root, runtime_file],
            ):
                command = vdd_accept._sandbox_command(
                    [sys.executable, "runner.py"],
                    workspace=workspace,
                    readable_files=[],
                    readable_dirs=[],
                    writable_files=[],
                    writable_dirs=[],
                    temp_root=temp_root,
                )
            profile = command[2]
            self.assertIn('(literal "/")', profile)
            self.assertNotIn('(subpath "/")', profile)
            self.assertIn(f'(subpath "{runtime_root}")', profile)
            self.assertIn(f'(literal "{runtime_file}")', profile)
            self.assertNotIn(f'(subpath "{workspace.resolve()}")', profile)

    def test_macos_sandbox_grants_workspace_root_metadata_without_recursive_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            temp_root = root / "temp"
            temp_root.mkdir()
            runtime_root = root / "runtime"
            runtime_root.mkdir()
            with mock.patch.object(vdd_accept.sys, "platform", "darwin"), mock.patch.object(
                vdd_accept.shutil, "which", return_value="/usr/bin/sandbox-exec"
            ), mock.patch.object(
                vdd_accept,
                "_runtime_read_roots",
                return_value=[runtime_root],
            ):
                command = vdd_accept._sandbox_command(
                    [sys.executable, "runner.py"],
                    workspace=workspace,
                    readable_files=[],
                    readable_dirs=[],
                    writable_files=[],
                    writable_dirs=[],
                    temp_root=temp_root,
                )
            profile = command[2]
            self.assertIn(f'(literal "{workspace.resolve()}")', profile)
            self.assertNotIn(f'(subpath "{workspace.resolve()}")', profile)
            self.assertIn('(allow file-read* (literal "/dev/null"))', profile)
            self.assertIn('(allow file-write* (literal "/dev/null"))', profile)
            self.assertNotIn('(allow mach-lookup)', profile)

    def test_macos_sandbox_grants_only_structural_read_for_declared_directory_parents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            declared = workspace / "tests" / "test_signer"
            declared.mkdir(parents=True)
            temp_root = root / "temp"
            temp_root.mkdir()
            runtime_root = root / "runtime"
            runtime_root.mkdir()
            with mock.patch.object(vdd_accept.sys, "platform", "darwin"), mock.patch.object(
                vdd_accept.shutil, "which", return_value="/usr/bin/sandbox-exec"
            ), mock.patch.object(
                vdd_accept,
                "_runtime_read_roots",
                return_value=[runtime_root],
            ):
                command = vdd_accept._sandbox_command(
                    [sys.executable, "runner.py"],
                    workspace=workspace,
                    readable_files=[],
                    readable_dirs=[declared],
                    writable_files=[],
                    writable_dirs=[],
                    temp_root=temp_root,
                )
            profile = command[2]
            self.assertIn(f'(literal "{(workspace / "tests").resolve()}")', profile)
            self.assertNotIn(f'(subpath "{(workspace / "tests").resolve()}")', profile)
            self.assertIn(f'(subpath "{declared}")', profile)

    def test_execution_read_scope_excludes_undeclared_workspace_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            candidate = workspace / "candidate.txt"
            protected = workspace / "protected.txt"
            undeclared = workspace / "secret.txt"
            candidate.write_text("candidate\n", encoding="utf-8")
            protected.write_text("protected\n", encoding="utf-8")
            undeclared.write_text("secret\n", encoding="utf-8")
            files, dirs = vdd_accept._execution_readable_targets(
                workspace,
                ["candidate.txt", "protected.txt"],
            )
            self.assertEqual({candidate.resolve(), protected.resolve()}, set(files))
            self.assertEqual([], dirs)
            self.assertNotIn(undeclared.resolve(), files)

    def test_execute_plan_does_not_carry_implicit_argv_reads_between_steps(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as snapshot_tmp:
            source = Path(source_tmp)
            snapshot = Path(snapshot_tmp)
            secret = snapshot / "protected" / "secret.txt"
            secret.parent.mkdir()
            secret.write_text("secret\n", encoding="utf-8")
            runner = snapshot / "runner.py"
            runner.write_text("raise SystemExit(0)\n", encoding="utf-8")
            observed: list[list[Path]] = []

            def run_step(argv, **kwargs):
                observed.append(list(kwargs["readable_files"]))
                return subprocess.CompletedProcess(argv, 0, b"", b"")

            plan = [
                {
                    "id": "EARLY",
                    "display": "early",
                    "argv": [sys.executable, "runner.py", "protected/secret.txt"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 1,
                    "write_paths": [],
                    "artifact_refs": [],
                    "claim_ids": [],
                    "defeater_ids": [],
                },
                {
                    "id": "LATER",
                    "display": "later",
                    "argv": [sys.executable, "runner.py"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 1,
                    "write_paths": [],
                    "artifact_refs": [],
                    "claim_ids": [],
                    "defeater_ids": [],
                },
            ]
            with mock.patch.object(vdd_accept, "_run_isolated_step", side_effect=run_step):
                vdd_accept._execute_plan(
                    plan,
                    snapshot,
                    {"PATH": os.environ["PATH"]},
                    source_workspace=source,
                    nonfatal_step_ids=set(),
                    allowed_outputs=[],
                    candidate_paths=[],
                    readable_protected_paths=[],
                )
            self.assertNotIn(secret.resolve(), observed[0])
            self.assertNotIn(secret.resolve(), observed[1])

    def test_execution_read_scope_preserves_declared_workspace_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "bin").mkdir()
            (workspace / "lib").mkdir()
            target = workspace / "lib" / "tool.py"
            target.write_text("VALUE = 1\n", encoding="utf-8")
            (workspace / "bin" / "tool.py").symlink_to("../lib/tool.py")

            files, directories = vdd_accept._execution_readable_targets(
                workspace,
                ["bin/tool.py"],
            )

            lexical = workspace.resolve() / "bin" / "tool.py"
            self.assertEqual([lexical, target.resolve()], files)
            self.assertEqual([], directories)

    def test_execution_read_scope_preserves_declared_workspace_directory_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "real-tools").mkdir()
            target = workspace / "real-tools" / "tool.py"
            target.write_text("VALUE = 1\n", encoding="utf-8")
            (workspace / "tools").symlink_to("real-tools", target_is_directory=True)

            files, directories = vdd_accept._execution_readable_targets(
                workspace,
                ["tools/"],
            )

            self.assertEqual([], files)
            self.assertEqual(
                [workspace.resolve() / "tools", target.parent.resolve()],
                directories,
            )

    def test_execution_environment_remaps_source_path_entries(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as snapshot_tmp:
            source = Path(source_tmp)
            snapshot = Path(snapshot_tmp)
            (source / "bin").mkdir()
            (snapshot / "bin").mkdir()
            prepared = vdd_accept._prepare_execution_environment(
                {
                    "PATH": f"{source / 'bin'}{os.pathsep}./tools{os.pathsep}/usr/bin",
                    "PYTHONPATH": str(source / "bin"),
                },
                source_workspace=source,
                snapshot_workspace=snapshot,
            )
            self.assertEqual(
                f"{(snapshot / 'bin').resolve()}{os.pathsep}"
                f"{(snapshot / 'tools').resolve()}{os.pathsep}/usr/bin",
                prepared["PATH"],
            )
            self.assertEqual(str((snapshot / "bin").resolve()), prepared["PYTHONPATH"])

    def test_execute_plan_prevents_delayed_descendant_side_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            marker = workspace / "daemon-survived"
            runner = workspace / "spawn.py"
            runner.write_text(
                "import os, time, pathlib, sys\n"
                f"marker = pathlib.Path({str(marker)!r})\n"
                "if os.fork() == 0:\n"
                "    time.sleep(0.75)\n"
                "    marker.write_text('survived')\n"
                "    raise SystemExit(0)\n"
                "raise SystemExit(0)\n",
                encoding="utf-8",
            )
            plan = [
                {
                    "id": "SPAWN",
                    "display": "spawn daemon",
                    "argv": [sys.executable, str(runner)],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 5,
                    "write_paths": ["daemon-survived"],
                    "artifact_refs": ["daemon-survived"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ]
            try:
                records = vdd_accept._execute_plan(
                    plan,
                    workspace,
                    {"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
                    source_workspace=workspace,
                    nonfatal_step_ids=set(),
                    allowed_outputs=["daemon-survived"],
                    candidate_paths=[],
                    readable_protected_paths=[],
                    producer_captures={},
                )
            except ValueError as exc:
                # macOS single-process fail-closed: fork/setsid denied (EPERM).
                self.assertRegex(
                    str(exc),
                    "fork|Operation not permitted|exited|timed out|process",
                )
            else:
                self.assertEqual("pass", records[0]["result"])
            time.sleep(1)
            self.assertFalse(
                marker.exists() and marker.read_text(encoding="utf-8") == "survived",
                "contained descendant performed a delayed side effect",
            )

    def test_write_json_refuses_symlink_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "secret.json"
            target.write_text('{"before":true}\n', encoding="utf-8")
            link = root / "attestation.json"
            link.symlink_to(target.name)
            with self.assertRaisesRegex(ValueError, "non-regular path|refusing to write"):
                vdd_accept._write_json(link, {"after": True})
            self.assertEqual('{"before":true}\n', target.read_text(encoding="utf-8"))

    def test_protected_cutover_and_release_overwrite_proposal_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            cutover_payload = {
                "callers_total": 2,
                "callers_migrated": 2,
                "unresolved": 0,
                "unknown": 0,
                "removed_production_paths": ["legacy/entry"],
                "legacy_runtime_dependencies": 0,
                "cutover_complete": True,
                "rollback_exercised": True,
            }
            release_payload = {
                "canary_or_shadow": "canary-protected",
                "thresholds_passed": True,
                "rollback_trigger": "error-rate > 0.5%",
                "release_owner": "release-owner",
            }
            runner = workspace / "runner.py"
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    "elif mode == 'bad':\n",
                    "elif mode == 'cutover':\n"
                    f"    pathlib.Path('cutover.json').write_text({json.dumps(json.dumps(cutover_payload))})\n"
                    "elif mode == 'release':\n"
                    f"    pathlib.Path('release.json').write_text({json.dumps(json.dumps(release_payload))})\n"
                    "elif mode == 'bad':\n",
                ),
                encoding="utf-8",
            )
            contract["mode"] = "equivalence"
            proposal["risk_profile"] = "standard"
            contract["risk_profile"] = "standard"
            contract["baseline"] = {
                "semantic_red_command": None,
                "reference_green_command": "qualify good",
                "semantic_green_command": "check candidate",
                "metric": None,
            }
            contract["cutover"] = {
                "strategy": "incremental",
                "completion": "all callers migrated",
                "rollback": "restore prior package",
            }
            contract["gates"]["release"] = "check candidate"
            contract["roles"]["release_owner"] = "release-owner"
            contract["control_plane"]["protected_assets"] = [
                item
                if item["path"] != "runner.py"
                else {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                }
                for item in contract["control_plane"]["protected_assets"]
            ]
            contract["control_plane"]["allowed_output_paths"].extend(
                ["cutover.json", "release.json"]
            )
            contract["control_plane"]["execution_plan"].extend(
                [
                    {
                        "id": "CUTOVER",
                        "display": "record cutover",
                        "argv": [sys.executable, "runner.py", "cutover"],
                        "expected_exit_code": 0,
                        "result": "pass",
                        "write_paths": ["cutover.json"],
                        "artifact_refs": ["cutover.json"],
                    },
                    {
                        "id": "RELEASE",
                        "display": "record release",
                        "argv": [sys.executable, "runner.py", "release"],
                        "expected_exit_code": 0,
                        "result": "pass",
                        "write_paths": ["release.json"],
                        "artifact_refs": ["release.json"],
                    },
                ]
            )
            contract["control_plane"]["cutover_result"] = {
                "command_id": "CUTOVER",
                "result_path": "cutover.json",
                "producer_path": "runner.py",
            }
            contract["control_plane"]["release_result"] = {
                "command_id": "RELEASE",
                "result_path": "release.json",
                "producer_path": "runner.py",
            }
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["mode"] = "equivalence"
            proposal["environment"] = copy.deepcopy(env)
            proposal["mode_evidence"] = {
                "reference_green_command": "GOOD",
                "deviation_rejection_commands": ["BAD"],
                "parity_commands": ["CHECK"],
                "identical_input_fingerprint": "sha256:" + "a" * 64,
                "behavior_classification": {
                    "accepted": ["behavior"],
                    "corrected": [],
                    "unknown": [],
                },
                "cutover": {
                    "callers_total": 99,
                    "callers_migrated": 0,
                    "unresolved": 99,
                    "unknown": 0,
                    "removed_production_paths": [],
                    "legacy_runtime_dependencies": 9,
                    "cutover_complete": False,
                    "rollback_exercised": False,
                    "result_command": "FORGED",
                },
            }
            proposal["merge"] = {
                "integration_passed": True,
                "cutover_complete": False,
                "rollback_exercised": False,
            }
            proposal["release"] = {
                "canary_or_shadow": "forged-canary",
                "thresholds_passed": False,
                "rollback_trigger": "forged",
                "release_owner": "forged-owner",
                "result_command": "FORGED",
            }
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            # First issue merge parent without release stage.
            merge_proposal = copy.deepcopy(proposal)
            merge_proposal["stage"] = "merge"
            parent = vdd_accept.issue_attestation(
                contract,
                merge_proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="cutover-merge",
            )
            self.assertTrue(parent["mode_evidence"]["cutover"]["cutover_complete"])
            self.assertEqual(
                "CUTOVER",
                parent["mode_evidence"]["cutover"]["result_command"],
            )
            self.assertNotEqual(
                99,
                parent["mode_evidence"]["cutover"]["callers_total"],
            )
            release_proposal = copy.deepcopy(proposal)
            release_proposal["stage"] = "release"
            release_proposal["merge"]["rollback_exercised"] = True
            attestation = vdd_accept.issue_attestation(
                contract,
                release_proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="cutover-release",
                parent_attestation=parent,
            )
            self.assertEqual("canary-protected", attestation["release"]["canary_or_shadow"])
            self.assertEqual("RELEASE", attestation["release"]["result_command"])
            self.assertNotEqual("forged-canary", attestation["release"]["canary_or_shadow"])

    def test_signature_rejects_tampered_attestation(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-3",
            )
            tampered = copy.deepcopy(attestation)
            tampered["claim_results"][0]["status"] = "refuted"
            self.assertFalse(
                vdd_accept.verify_attestation_signature(
                    tampered,
                    b"control-plane-secret",
                )
            )

    def test_multi_defeater_expected_reject_requires_every_signal(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["claims"].append(
                {
                    "id": "C-TRIM",
                    "statement": "slugify trims leading and trailing hyphens.",
                    "scope": "public slugify(title) API",
                    "severity": "medium",
                    "assumptions": [],
                    "oracle_ids": ["O-SLUG-UNIT"],
                    "defeater_ids": ["D-LEADING-HYPHEN"],
                }
            )
            contract["defeaters"].append(
                {
                    "id": "D-LEADING-HYPHEN",
                    "claim_id": "C-TRIM",
                    "description": "Leading hyphens survive.",
                    "failure_class": "CONTRACT",
                    "severity": "medium",
                    "status": "covered",
                    "oracle_ids": ["O-SLUG-UNIT"],
                    "qualification_fault": "emit leading hyphen",
                    "risk_owner": None,
                }
            )
            contract["oracles"][0]["claims"] = ["C-SLUG", "C-TRIM"]
            contract["oracles"][0]["qualification"]["known_bad_cases"].append(
                {
                    "defeater_id": "D-LEADING-HYPHEN",
                    "fault": "leading hyphen temporary candidate",
                    "expected_rejection": "LEADING differs: -a != a",
                }
            )
            # One expected_reject step covers both defeaters but only emits D-A signal.
            contract["control_plane"]["execution_plan"][1]["defeater_ids"] = [
                "D-REPEATED-SEPARATOR",
                "D-LEADING-HYPHEN",
            ]
            contract["control_plane"]["execution_plan"][4]["claim_ids"] = [
                "C-SLUG",
                "C-TRIM",
            ]
            contract["control_plane"]["execution_plan"][4]["defeater_ids"] = [
                "D-REPEATED-SEPARATOR",
                "D-LEADING-HYPHEN",
            ]
            proposal["claim_results"].append(
                {
                    "claim_id": "C-TRIM",
                    "status": "confirmed",
                    "evidence_refs": ["CHECK"],
                }
            )
            proposal["defeater_results"].append(
                {
                    "defeater_id": "D-LEADING-HYPHEN",
                    "status": "eliminated",
                    "evidence_refs": ["BAD", "CHECK"],
                }
            )
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            with self.assertRaisesRegex(
                ValueError,
                "missing expected rejection signal|exited 1",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-multi-defeater-partial-signal",
                )

    def test_file_outputs_do_not_grant_parent_directory_write_authority(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            artifacts = workspace / "artifacts"
            artifacts.mkdir()
            protected_sibling = artifacts / "discover.py"
            protected_sibling.write_text("print('protected')\n", encoding="utf-8")
            discovery = artifacts / "discovery.json"
            discovery.write_text("{}\n", encoding="utf-8")
            files, dirs = vdd_accept._execution_writable_targets(
                workspace,
                ["artifacts/discovery.json"],
                [],
            )
            self.assertEqual([discovery.resolve()], files)
            self.assertNotIn(artifacts.resolve(), dirs)
            # Nested protected sibling must not be writable via parent dir authority.
            self.assertFalse(any(path == protected_sibling.resolve() for path in files))

    def test_directory_outputs_preserve_directory_write_authority(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            out_dir = workspace / "artifacts"
            out_dir.mkdir()
            (out_dir / "stale.json").write_text("{}\n", encoding="utf-8")
            files, dirs = vdd_accept._execution_writable_targets(
                workspace,
                ["artifacts"],
                [],
            )
            self.assertEqual([], files)
            self.assertIn(out_dir.resolve(), dirs)

            # issue_attestation cleanup must preserve directory-typed outputs.
            contract, proposal, _ = self.make_case(workspace)
            runner = workspace / "runner.py"
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    "if mode == 'discover':\n"
                    "    pathlib.Path('discovery.json').write_text(DISCOVERY)\n",
                    "if mode == 'discover':\n"
                    "    pathlib.Path('artifacts').mkdir(exist_ok=True)\n"
                    "    pathlib.Path('artifacts/discovery.json').write_text(DISCOVERY)\n",
                ),
                encoding="utf-8",
            )
            contract["control_plane"]["protected_assets"] = [
                item
                if item["path"] != "runner.py"
                else {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                }
                for item in contract["control_plane"]["protected_assets"]
            ]
            contract["control_plane"]["allowed_output_paths"] = [
                "artifacts",
                "artifacts/discovery.json",
            ]
            contract["control_plane"]["discovery"]["result_path"] = "artifacts/discovery.json"
            contract["control_plane"]["execution_plan"][3]["write_paths"] = [
                "artifacts"
            ]
            contract["control_plane"]["execution_plan"][3]["artifact_refs"] = [
                "artifacts/discovery.json"
            ]
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-directory-output",
            )
            self.assertEqual(
                contract["test_discovery"]["expected"],
                attestation["test_discovery"]["discovered"],
            )


    def test_release_result_requires_producer_in_argv(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            contract["gates"]["release"] = "check candidate"
            contract["roles"]["release_owner"] = "release-owner"
            dummy = workspace / "dummy-protected.txt"
            dummy.write_text("dummy\n", encoding="utf-8")
            candidate_writer = workspace / "candidate.txt"
            candidate_writer.write_text(
                "import pathlib, json, sys\n"
                "pathlib.Path('release.json').write_text(json.dumps({"
                "'canary_or_shadow':'forged',"
                "'thresholds_passed':True,"
                "'rollback_trigger':'x',"
                "'release_owner':'release-owner'}))\n",
                encoding="utf-8",
            )
            contract["scope"]["protected"].append("dummy-protected.txt")
            contract["control_plane"]["protected_assets"].append(
                {
                    "path": "dummy-protected.txt",
                    "fingerprint": vdd_accept.file_fingerprint(dummy),
                }
            )
            contract["control_plane"]["allowed_output_paths"].append("release.json")
            contract["control_plane"]["execution_plan"].append(
                {
                    "id": "RELEASE",
                    "display": "release canary",
                    "argv": [sys.executable, "candidate.txt", "dummy-protected.txt"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": ["release.json"],
                    "artifact_refs": ["release.json"],
                }
            )
            contract["control_plane"]["release_result"] = {
                "command_id": "RELEASE",
                "result_path": "release.json",
                "producer_path": "dummy-protected.txt",
            }
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            proposal["stage"] = "release"
            proposal["merge"]["rollback_exercised"] = True
            proposal["release"] = {
                "canary_or_shadow": "forged",
                "thresholds_passed": True,
                "rollback_trigger": "x",
                "release_owner": "release-owner",
            }
            with self.assertRaisesRegex(
                ValueError,
                "producer_path must appear in the producer step argv",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-release-producer-not-in-argv",
                    parent_attestation={
                        "schema_version": "vdd-0.4",
                        "attestation_id": "parent",
                        "stage": "merge",
                        "status": "accepted",
                        "contract": {"fingerprint": proposal["contract"]["fingerprint"]},
                        "candidate": {"revision": "x", "artifact_digests": []},
                        "control_plane": {
                            "attestation_digest": "sha256:" + "0" * 64,
                            "signature": "hmac-sha256:" + "0" * 64,
                        },
                    },
                )

    def test_rejects_external_absolute_argv_operands_except_executable(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as snapshot_tmp:
            source = Path(source_tmp)
            snapshot = Path(snapshot_tmp)
            external = Path(tempfile.mkstemp(prefix="vdd-external-")[1])
            try:
                external.write_text('{"baseline": true}\n', encoding="utf-8")
                with self.assertRaisesRegex(
                    ValueError,
                    "external absolute|external path|rejects external",
                ):
                    vdd_accept._snapshot_argv(
                        [sys.executable, str(external)],
                        source,
                        snapshot,
                    )
            finally:
                external.unlink(missing_ok=True)

    def test_rejects_external_library_path_entries(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as snapshot_tmp:
            source = Path(source_tmp)
            snapshot = Path(snapshot_tmp)
            (source / "bin").mkdir()
            (snapshot / "bin").mkdir()
            with self.assertRaisesRegex(
                ValueError,
                "PYTHONPATH|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|external",
            ):
                vdd_accept._prepare_execution_environment(
                    {
                        "PATH": f"{source / 'bin'}{os.pathsep}/usr/bin",
                        "PYTHONPATH": f"{source / 'bin'}{os.pathsep}/usr/local/lib/vdd-oracle",
                    },
                    source_workspace=source,
                    snapshot_workspace=snapshot,
                )

    def test_execute_plan_contains_or_cleans_detached_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            marker = workspace / "detached-survived"
            runner = workspace / "detach.py"
            runner.write_text(
                "import os, pathlib, sys, time\n"
                f"marker = pathlib.Path({str(marker)!r})\n"
                "pid = os.fork()\n"
                "if pid == 0:\n"
                "    os.setsid()\n"
                "    time.sleep(0.75)\n"
                "    marker.write_text('survived')\n"
                "    raise SystemExit(0)\n"
                "raise SystemExit(0)\n",
                encoding="utf-8",
            )
            plan = [
                {
                    "id": "DETACH",
                    "display": "spawn detached",
                    "argv": [sys.executable, str(runner)],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 5,
                    "write_paths": ["detached-survived"],
                    "artifact_refs": ["detached-survived"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ]
            try:
                records = vdd_accept._execute_plan(
                    plan,
                    workspace,
                    {"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
                    source_workspace=workspace,
                    nonfatal_step_ids=set(),
                    allowed_outputs=["detached-survived"],
                    candidate_paths=[],
                    readable_protected_paths=[],
                    producer_captures={},
                )
            except ValueError as exc:
                # macOS single-process fail-closed: fork/setsid denied (EPERM).
                self.assertRegex(
                    str(exc),
                    "fork|Operation not permitted|exited|timed out|process",
                )
            else:
                self.assertEqual("pass", records[0]["result"])
            time.sleep(1)
            self.assertFalse(
                marker.exists() and marker.read_text(encoding="utf-8") == "survived",
                "detached child performed a delayed side effect",
            )

    def test_execute_plan_fails_closed_on_immediate_detached_child(self):
        """Immediate setsid child cannot be accepted via sampling races.

        macOS reference policy is single-process fail-closed (deny process-fork).
        Linux relies on bwrap --unshare-pid/--die-with-parent.
        """
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            marker = workspace / "immediate-detached"
            runner = workspace / "immediate_detach.py"
            runner.write_text(
                "import os, pathlib, sys, time\n"
                f"marker = pathlib.Path({str(marker)!r})\n"
                "pid = os.fork()\n"
                "if pid == 0:\n"
                "    os.setsid()\n"
                "    # Parent returns immediately; no sleep race window.\n"
                "    time.sleep(0.75)\n"
                "    marker.write_text('survived')\n"
                "    while True:\n"
                "        pass\n"
                "raise SystemExit(0)\n",
                encoding="utf-8",
            )
            plan = [
                {
                    "id": "IMMEDIATE-DETACH",
                    "display": "immediate detached child",
                    "argv": [sys.executable, str(runner)],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "timeout_seconds": 5,
                    "write_paths": ["immediate-detached"],
                    "artifact_refs": ["immediate-detached"],
                    "claim_ids": [],
                    "defeater_ids": [],
                }
            ]
            try:
                records = vdd_accept._execute_plan(
                    plan,
                    workspace,
                    {"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
                    source_workspace=workspace,
                    nonfatal_step_ids=set(),
                    allowed_outputs=["immediate-detached"],
                    candidate_paths=[],
                    readable_protected_paths=[],
                    producer_captures={},
                )
            except ValueError as exc:
                self.assertRegex(
                    str(exc),
                    "fork|Operation not permitted|exited|timed out|process",
                )
            else:
                self.assertEqual("pass", records[0]["result"])
            time.sleep(1)
            self.assertFalse(
                marker.exists() and marker.read_text(encoding="utf-8") == "survived",
                "immediate detached child escaped containment",
            )


    def test_write_json_rejects_symlink_ancestors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / "outside"
            outside.mkdir()
            (outside / "sub").mkdir()
            link = root / "link"
            link.symlink_to(outside)
            target = link / "sub" / "result.json"
            with self.assertRaisesRegex(ValueError, "symlink|non-regular|refusing"):
                vdd_accept._write_json(target, {"escaped": True})
            self.assertFalse((outside / "sub" / "result.json").exists())

    def test_write_json_rejects_intermediate_symlink_via_openat(self):
        """openat walk must not follow an intermediate directory replaced by symlink."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / "outside"
            outside.mkdir()
            (outside / "secret.json").write_text('{"secret":true}\n', encoding="utf-8")
            nested = root / "a" / "b"
            nested.mkdir(parents=True)
            # Replace intermediate 'a' with a symlink after path construction.
            real_a = root / "a"
            moved = root / "a-real"
            real_a.rename(moved)
            real_a.symlink_to(outside)
            target = root / "a" / "b" / "result.json"
            with self.assertRaisesRegex(ValueError, "symlink|non-directory|refusing"):
                vdd_accept._write_json(target, {"escaped": True})
            self.assertFalse((outside / "b" / "result.json").exists())
            self.assertEqual(
                '{"secret":true}\n',
                (outside / "secret.json").read_text(encoding="utf-8"),
            )

    def test_write_json_pins_parent_during_intermediate_symlink_swap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real_a = root / "a"
            nested = real_a / "b"
            nested.mkdir(parents=True)
            outside = root / "outside"
            (outside / "b").mkdir(parents=True)
            moved = root / "a-pinned"
            destination = nested / "result.json"
            real_open = os.open
            swapped = False

            def racing_open(
                path,
                flags,
                mode=0o777,
                *,
                dir_fd=None,
            ):
                nonlocal swapped
                if path == "b" and dir_fd is not None and not swapped:
                    real_a.rename(moved)
                    real_a.symlink_to(outside)
                    swapped = True
                return real_open(path, flags, mode, dir_fd=dir_fd)

            with mock.patch.object(os, "open", side_effect=racing_open):
                vdd_accept._write_json(destination, {"safe": True})

            self.assertTrue(swapped)
            self.assertFalse((outside / "b" / "result.json").exists())
            self.assertEqual(
                {"safe": True},
                json.loads((moved / "b" / "result.json").read_text(encoding="utf-8")),
            )


    def test_write_json_retains_destination_on_atomic_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = root / "attestation.json"
            destination.write_text('{"before": true}\n', encoding="utf-8")
            original = destination.read_text(encoding="utf-8")

            real_replace = os.replace

            def boom_replace(src, dst, *args, **kwargs):
                raise OSError("simulated replace failure")

            with mock.patch.object(vdd_accept.os, "replace", side_effect=boom_replace):
                with self.assertRaises(OSError):
                    vdd_accept._write_json(destination, {"after": True})
            self.assertEqual(original, destination.read_text(encoding="utf-8"))
            # No pre-unlink: destination must remain a regular file with prior content.
            self.assertTrue(destination.is_file())
            self.assertFalse(destination.is_symlink())
            del real_replace

    def test_critical_platform_results_issue_and_bind_matrix_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            actual_platform = vdd_accept.runtime_platform_identity()["platform_id"]
            platforms = [actual_platform]
            contract["risk_profile"] = "critical"
            proposal["risk_profile"] = "critical"
            contract["gates"]["integration"] = "check candidate"
            contract["gates"]["release"] = "check candidate"
            contract["roles"]["release_owner"] = "release-owner"
            proposal["merge"]["rollback_exercised"] = True
            release_payload = {
                "canary_or_shadow": "canary-critical",
                "thresholds_passed": True,
                "rollback_trigger": "error-rate > 0.1%",
                "release_owner": "release-owner",
            }
            platform_payload = {"platform": actual_platform, "passed": True}
            runner = workspace / "runner.py"
            mode_branches = (
                "elif mode == 'release':\n"
                f"    pathlib.Path('release.json').write_text({json.dumps(json.dumps(release_payload))})\n"
                f"elif mode == 'platform-{actual_platform}':\n"
                f"    pathlib.Path('platform-{actual_platform}.json').write_text("
                f"{json.dumps(json.dumps(platform_payload))})\n"
            )
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    "elif mode == 'bad':\n",
                    mode_branches + "elif mode == 'bad':\n",
                ),
                encoding="utf-8",
            )
            contract["control_plane"]["protected_assets"] = [
                item
                if item["path"] != "runner.py"
                else {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                }
                for item in contract["control_plane"]["protected_assets"]
            ]
            contract["control_plane"]["allowed_output_paths"].append("release.json")
            contract["control_plane"]["execution_plan"].append(
                {
                    "id": "RELEASE",
                    "display": "release canary",
                    "argv": [sys.executable, "runner.py", "release"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": ["release.json"],
                    "artifact_refs": ["release.json"],
                }
            )
            contract["control_plane"]["release_result"] = {
                "command_id": "RELEASE",
                "result_path": "release.json",
                "producer_path": "runner.py",
            }
            command_id = "PLATFORM_ACTUAL"
            result_path = f"platform-{actual_platform}.json"
            contract["control_plane"]["allowed_output_paths"].append(result_path)
            contract["control_plane"]["execution_plan"].append(
                {
                    "id": command_id,
                    "display": f"platform {actual_platform}",
                    "argv": [
                        sys.executable,
                        "runner.py",
                        f"platform-{actual_platform}",
                    ],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [result_path],
                    "artifact_refs": [result_path],
                }
            )
            contract["control_plane"]["platform_results"] = {
                actual_platform: {
                    "command_id": command_id,
                    "result_path": result_path,
                    "producer_path": "runner.py",
                }
            }
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"] = {
                "digest": env["digest"],
                "required": contract["control_plane"]["environment_allowlist"],
                "matrix": platforms,
                "fingerprint_fields": [
                    "allowlisted variables",
                    "executables",
                    "runtime",
                ],
            }
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-critical-platform-matrix",
            )
            matrix_evidence = attestation["environment"]["details"]["platform_matrix_evidence"]
            self.assertEqual({actual_platform: command_id}, matrix_evidence)
            runtime = attestation["environment"]["details"]["runtime"]
            self.assertEqual(actual_platform, runtime["platform_id"])
            self.assertEqual(
                vdd_accept.runtime_platform_identity()["system"],
                runtime["system"],
            )
            self.assertEqual(
                vdd_accept.runtime_platform_identity()["machine"],
                runtime["machine"],
            )
            self.assertEqual(env["digest"], attestation["environment"]["digest"])
            by_id = {record["id"]: record for record in attestation["commands"]}
            record = by_id[command_id]
            self.assertEqual("pass", record["result"])
            self.assertEqual(
                {"platform": actual_platform, "passed": True},
                record["captured_result"]["value"],
            )
            # Multi-platform matrix must fail closed in the reference issuer.
            multi = copy.deepcopy(contract)
            foreign = "linux-x86_64" if actual_platform != "linux-x86_64" else "macos-arm64"
            multi["environment"]["matrix"] = [actual_platform, foreign]
            multi["control_plane"]["platform_results"][foreign] = {
                "command_id": "PLATFORM_FOREIGN",
                "result_path": f"platform-{foreign}.json",
                "producer_path": "runner.py",
            }
            multi["control_plane"]["allowed_output_paths"].append(
                f"platform-{foreign}.json"
            )
            multi["control_plane"]["execution_plan"].append(
                {
                    "id": "PLATFORM_FOREIGN",
                    "display": f"platform {foreign}",
                    "argv": [sys.executable, "runner.py", "good"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [f"platform-{foreign}.json"],
                    "artifact_refs": [f"platform-{foreign}.json"],
                }
            )
            multi_env = vdd_accept.derive_environment_identity(
                execution_environment,
                multi["control_plane"]["execution_plan"],
                workspace,
            )
            multi["environment"]["digest"] = multi_env["digest"]
            multi_proposal = copy.deepcopy(proposal)
            multi_proposal["environment"] = copy.deepcopy(multi_env)
            multi_proposal["contract"]["fingerprint"] = (
                vdd_accept.contract_fingerprint(multi)
            )
            with self.assertRaisesRegex(
                ValueError,
                "exactly one Critical platform|multi-platform|external authenticated",
            ):
                vdd_accept.issue_attestation(
                    multi,
                    multi_proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-critical-multi-platform",
                )


    def _critical_platform_case(self, workspace: Path, platform_name: str):
        contract, proposal, _ = self.make_case(workspace)
        contract["risk_profile"] = "critical"
        proposal["risk_profile"] = "critical"
        contract["gates"]["integration"] = "check candidate"
        contract["gates"]["release"] = "check candidate"
        contract["roles"]["release_owner"] = "release-owner"
        proposal["merge"]["rollback_exercised"] = True
        release_payload = {
            "canary_or_shadow": "canary-critical",
            "thresholds_passed": True,
            "rollback_trigger": "error-rate > 0.1%",
            "release_owner": "release-owner",
        }
        platform_payload = {"platform": platform_name, "passed": True}
        runner = workspace / "runner.py"
        mode_branches = (
            "elif mode == 'release':\n"
            f"    pathlib.Path('release.json').write_text({json.dumps(json.dumps(release_payload))})\n"
            f"elif mode == 'platform-{platform_name}':\n"
            f"    pathlib.Path('platform-{platform_name}.json').write_text("
            f"{json.dumps(json.dumps(platform_payload))})\n"
        )
        runner.write_text(
            runner.read_text(encoding="utf-8").replace(
                "elif mode == 'bad':\n",
                mode_branches + "elif mode == 'bad':\n",
            ),
            encoding="utf-8",
        )
        contract["control_plane"]["protected_assets"] = [
            item
            if item["path"] != "runner.py"
            else {
                "path": "runner.py",
                "fingerprint": vdd_accept.file_fingerprint(runner),
            }
            for item in contract["control_plane"]["protected_assets"]
        ]
        contract["control_plane"]["allowed_output_paths"].extend(
            ["release.json", f"platform-{platform_name}.json"]
        )
        contract["control_plane"]["execution_plan"].append(
            {
                "id": "RELEASE",
                "display": "release canary",
                "argv": [sys.executable, "runner.py", "release"],
                "expected_exit_code": 0,
                "result": "pass",
                "write_paths": ["release.json"],
                "artifact_refs": ["release.json"],
            }
        )
        contract["control_plane"]["release_result"] = {
            "command_id": "RELEASE",
            "result_path": "release.json",
            "producer_path": "runner.py",
        }
        command_id = "PLATFORM_CLAIM"
        result_path = f"platform-{platform_name}.json"
        contract["control_plane"]["execution_plan"].append(
            {
                "id": command_id,
                "display": f"platform {platform_name}",
                "argv": [
                    sys.executable,
                    "runner.py",
                    f"platform-{platform_name}",
                ],
                "expected_exit_code": 0,
                "result": "pass",
                "write_paths": [result_path],
                "artifact_refs": [result_path],
            }
        )
        contract["control_plane"]["platform_results"] = {
            platform_name: {
                "command_id": command_id,
                "result_path": result_path,
                "producer_path": "runner.py",
            }
        }
        execution_environment = {
            name: os.environ[name]
            for name in contract["control_plane"]["environment_allowlist"]
        }
        env = vdd_accept.derive_environment_identity(
            execution_environment,
            contract["control_plane"]["execution_plan"],
            workspace,
        )
        contract["environment"] = {
            "digest": env["digest"],
            "required": contract["control_plane"]["environment_allowlist"],
            "matrix": [platform_name],
            "fingerprint_fields": [
                "allowlisted variables",
                "executables",
                "runtime",
            ],
        }
        proposal["environment"] = copy.deepcopy(env)
        proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
        return contract, proposal

    def _install_external_marker_step(
        self,
        contract: dict,
        proposal: dict,
        workspace: Path,
        marker: Path,
    ) -> None:
        """Rewrite first plan step to touch an absolute marker if execution starts."""
        contract["control_plane"]["execution_plan"][0] = {
            "id": "MARK",
            "display": "side-effect marker",
            "argv": [
                sys.executable,
                "-c",
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
            ],
            "expected_exit_code": 0,
            "result": "pass",
            "write_paths": [],
            "artifact_refs": [],
        }
        execution_environment = {
            name: os.environ[name]
            for name in contract["control_plane"]["environment_allowlist"]
        }
        env = vdd_accept.derive_environment_identity(
            execution_environment,
            contract["control_plane"]["execution_plan"],
            workspace,
        )
        contract["environment"]["digest"] = env["digest"]
        proposal["environment"] = copy.deepcopy(env)
        proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)

    def test_critical_rejects_foreign_platform_before_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            actual_platform = vdd_accept.runtime_platform_identity()["platform_id"]
            foreign = (
                "linux-x86_64" if actual_platform != "linux-x86_64" else "macos-arm64"
            )
            contract, proposal = self._critical_platform_case(workspace, foreign)
            marker = workspace / "external-marker.txt"
            self._install_external_marker_step(contract, proposal, workspace, marker)
            with self.assertRaisesRegex(
                ValueError,
                "critical platform key must equal actual issuer runtime platform_id",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-critical-foreign-platform",
                )
            self.assertFalse(marker.exists())

    def test_critical_rejects_multi_platform_before_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            actual_platform = vdd_accept.runtime_platform_identity()["platform_id"]
            foreign = (
                "linux-x86_64" if actual_platform != "linux-x86_64" else "macos-arm64"
            )
            contract, proposal = self._critical_platform_case(workspace, actual_platform)
            contract["environment"]["matrix"] = [actual_platform, foreign]
            contract["environment"][
                "platform_evidence_authority"
            ] = "external-attestation-aggregator"
            contract["control_plane"]["platform_results"][foreign] = {
                "command_id": "PLATFORM_FOREIGN",
                "result_path": f"platform-{foreign}.json",
                "producer_path": "runner.py",
            }
            contract["control_plane"]["allowed_output_paths"].append(
                f"platform-{foreign}.json"
            )
            contract["control_plane"]["execution_plan"].append(
                {
                    "id": "PLATFORM_FOREIGN",
                    "display": f"platform {foreign}",
                    "argv": [sys.executable, "runner.py", "good"],
                    "expected_exit_code": 0,
                    "result": "pass",
                    "write_paths": [f"platform-{foreign}.json"],
                    "artifact_refs": [f"platform-{foreign}.json"],
                }
            )
            marker = workspace / "external-marker.txt"
            self._install_external_marker_step(contract, proposal, workspace, marker)
            with self.assertRaisesRegex(
                ValueError,
                "exactly one Critical platform|multi-platform acceptance requires an "
                "external authenticated control plane",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-critical-multi-before-commands",
                )
            self.assertFalse(marker.exists())

    def test_critical_rejects_producer_claiming_foreign_platform(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            actual_platform = vdd_accept.runtime_platform_identity()["platform_id"]
            foreign = (
                "linux-x86_64" if actual_platform != "linux-x86_64" else "macos-arm64"
            )
            contract, proposal = self._critical_platform_case(workspace, actual_platform)
            runner = workspace / "runner.py"
            honest = {"platform": actual_platform, "passed": True}
            forged = {"platform": foreign, "passed": True}
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    f"elif mode == 'platform-{actual_platform}':\n"
                    f"    pathlib.Path('platform-{actual_platform}.json').write_text("
                    f"{json.dumps(json.dumps(honest))})\n",
                    f"elif mode == 'platform-{actual_platform}':\n"
                    f"    pathlib.Path('platform-{actual_platform}.json').write_text("
                    f"{json.dumps(json.dumps(forged))})\n",
                ),
                encoding="utf-8",
            )
            contract["control_plane"]["protected_assets"] = [
                item
                if item["path"] != "runner.py"
                else {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                }
                for item in contract["control_plane"]["protected_assets"]
            ]
            with self.assertRaisesRegex(
                ValueError,
                r"protected platform result.*(missing or mismatched|must be)",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-critical-forged-platform-claim",
                )



    def test_nested_file_output_without_parent_write_authority(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            # Nested discovery output whose parent is not a declared directory output.
            runner = workspace / "runner.py"
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    "if mode == 'discover':\n"
                    "    pathlib.Path('discovery.json').write_text(DISCOVERY)\n",
                    "if mode == 'discover':\n"
                    "    pathlib.Path('artifacts').mkdir(parents=True, exist_ok=True)\n"
                    "    pathlib.Path('artifacts/discovery.json').write_text(DISCOVERY)\n",
                ),
                encoding="utf-8",
            )
            contract["control_plane"]["protected_assets"] = [
                item
                if item["path"] != "runner.py"
                else {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(runner),
                }
                for item in contract["control_plane"]["protected_assets"]
            ]
            contract["control_plane"]["allowed_output_paths"] = ["artifacts/discovery.json"]
            contract["control_plane"]["discovery"]["result_path"] = "artifacts/discovery.json"
            contract["control_plane"]["execution_plan"][3]["write_paths"] = [
                "artifacts/discovery.json"
            ]
            contract["control_plane"]["execution_plan"][3]["artifact_refs"] = [
                "artifacts/discovery.json"
            ]
            # Parent artifacts/ must not receive directory write authority.
            files, dirs = vdd_accept._execution_writable_targets(
                workspace,
                ["artifacts/discovery.json"],
                [],
            )
            self.assertEqual(
                [(workspace / "artifacts/discovery.json").resolve()],
                files,
            )
            self.assertNotIn((workspace / "artifacts").resolve(), dirs)
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-nested-file-output",
            )
            self.assertEqual(
                contract["test_discovery"]["expected"],
                attestation["test_discovery"]["discovered"],
            )



    def test_producer_accepts_interpreter_flags_before_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            # Valid shell-free form: python -I -u runner.py discover
            for step in contract["control_plane"]["execution_plan"]:
                if step["id"] == "DISCOVERY":
                    step["argv"] = [sys.executable, "-I", "-u", "runner.py", "discover"]
            contract["candidate_capabilities"]["allowed_commands"] = [
                f"{sys.executable} runner.py",
                f"{sys.executable} -I -u runner.py",
            ]
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(contract)
            attestation = vdd_accept.issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=b"control-plane-secret",
                run_id="run-interpreter-flags-producer",
            )
            self.assertEqual(
                contract["test_discovery"]["expected"],
                attestation["test_discovery"]["discovered"],
            )

    def test_producer_rejects_bash_option_operand_as_executed_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            protected_option = workspace / "extglob"
            protected_option.write_text("protected option operand\n", encoding="utf-8")
            candidate_writer = workspace / "candidate_writer.sh"
            candidate_writer.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate_writer.chmod(0o755)
            contract["scope"]["editable"].append("candidate_writer.sh")
            contract["candidate_capabilities"]["writable_paths"].append(
                "candidate_writer.sh"
            )
            contract["control_plane"]["candidate_artifacts"].append(
                "candidate_writer.sh"
            )
            contract["scope"]["protected"].append("extglob")
            contract["control_plane"]["protected_assets"].append(
                {
                    "path": "extglob",
                    "fingerprint": vdd_accept.file_fingerprint(protected_option),
                }
            )
            for step in contract["control_plane"]["execution_plan"]:
                if step["id"] == "DISCOVERY":
                    step["argv"] = [
                        "/bin/bash",
                        "-O",
                        "extglob",
                        "candidate_writer.sh",
                    ]
            contract["candidate_capabilities"]["allowed_commands"].append(
                "/bin/bash -O extglob candidate_writer.sh"
            )
            contract["control_plane"]["discovery"]["producer_path"] = "extglob"
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            environment_identity = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = environment_identity["digest"]
            proposal["environment"] = copy.deepcopy(environment_identity)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(
                contract
            )
            with self.assertRaisesRegex(
                ValueError,
                "producer_path must appear in the producer step argv",
            ):
                vdd_accept._preflight_control_plane(contract, workspace)

    def test_producer_rejects_ruby_include_path_as_executed_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            protected_dummy = workspace / "protected_dummy.rb"
            protected_dummy.write_text("# protected but not executed\n", encoding="utf-8")
            candidate_writer = workspace / "candidate_writer.rb"
            candidate_writer.write_text("puts 'forged'\n", encoding="utf-8")
            contract["scope"]["editable"].append("candidate_writer.rb")
            contract["candidate_capabilities"]["writable_paths"].append(
                "candidate_writer.rb"
            )
            contract["control_plane"]["candidate_artifacts"].append(
                "candidate_writer.rb"
            )
            contract["scope"]["protected"].append("protected_dummy.rb")
            contract["control_plane"]["protected_assets"].append(
                {
                    "path": "protected_dummy.rb",
                    "fingerprint": vdd_accept.file_fingerprint(protected_dummy),
                }
            )
            for step in contract["control_plane"]["execution_plan"]:
                if step["id"] == "DISCOVERY":
                    step["argv"] = [
                        "/usr/bin/ruby",
                        "-I",
                        "protected_dummy.rb",
                        "candidate_writer.rb",
                    ]
            contract["candidate_capabilities"]["allowed_commands"].append(
                "/usr/bin/ruby -I protected_dummy.rb candidate_writer.rb"
            )
            contract["control_plane"]["discovery"]["producer_path"] = (
                "protected_dummy.rb"
            )
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            environment_identity = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = environment_identity["digest"]
            proposal["environment"] = copy.deepcopy(environment_identity)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(
                contract
            )
            with self.assertRaisesRegex(
                ValueError,
                "producer_path must appear in the producer step argv",
            ):
                vdd_accept._preflight_control_plane(contract, workspace)

    def test_producer_rejects_candidate_interpreter_lookalike(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            # Attacker-controlled basename that previously matched startswith("python").
            lookalike = workspace / "python-candidate"
            lookalike.write_text(
                "#!/bin/sh\n"
                "printf '%s' \"$1\" > discovery.json\n",
                encoding="utf-8",
            )
            lookalike.chmod(0o755)
            dummy = workspace / "protected_dummy.py"
            dummy.write_text("# not executed\n", encoding="utf-8")
            contract["scope"]["editable"] = ["candidate.txt", "python-candidate"]
            contract["candidate_capabilities"]["writable_paths"] = [
                "candidate.txt",
                "python-candidate",
            ]
            contract["control_plane"]["candidate_artifacts"] = [
                "candidate.txt",
                "python-candidate",
            ]
            contract["scope"]["protected"] = [
                "runner.py",
                "protected.txt",
                "protected_dummy.py",
            ]
            contract["control_plane"]["protected_assets"] = [
                {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(workspace / "runner.py"),
                },
                {
                    "path": "protected.txt",
                    "fingerprint": vdd_accept.file_fingerprint(
                        workspace / "protected.txt"
                    ),
                },
                {
                    "path": "protected_dummy.py",
                    "fingerprint": vdd_accept.file_fingerprint(dummy),
                },
            ]
            for step in contract["control_plane"]["execution_plan"]:
                if step["id"] == "DISCOVERY":
                    # Candidate binary writes discovery; protected dummy is passive argv.
                    step["argv"] = ["./python-candidate", "protected_dummy.py"]
            contract["control_plane"]["discovery"]["producer_path"] = "protected_dummy.py"
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(
                contract
            )
            with self.assertRaisesRegex(
                ValueError,
                "producer_path must appear in the producer step argv",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-forged-python-candidate-producer",
                )

    def test_producer_rejects_candidate_named_python3(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            # Exact trusted basename, but identity is a candidate artifact.
            spoof = workspace / "python3"
            spoof.write_text(
                "#!/bin/sh\n"
                "# ignore protected_dummy.py and forge discovery\n"
                "printf '%s' 'forged' > discovery.json\n",
                encoding="utf-8",
            )
            spoof.chmod(0o755)
            dummy = workspace / "protected_dummy.py"
            dummy.write_text("# not executed\n", encoding="utf-8")
            contract["scope"]["editable"] = ["candidate.txt", "python3"]
            contract["candidate_capabilities"]["writable_paths"] = [
                "candidate.txt",
                "python3",
            ]
            contract["control_plane"]["candidate_artifacts"] = [
                "candidate.txt",
                "python3",
            ]
            contract["scope"]["protected"] = [
                "runner.py",
                "protected.txt",
                "protected_dummy.py",
            ]
            contract["control_plane"]["protected_assets"] = [
                {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(workspace / "runner.py"),
                },
                {
                    "path": "protected.txt",
                    "fingerprint": vdd_accept.file_fingerprint(
                        workspace / "protected.txt"
                    ),
                },
                {
                    "path": "protected_dummy.py",
                    "fingerprint": vdd_accept.file_fingerprint(dummy),
                },
            ]
            for step in contract["control_plane"]["execution_plan"]:
                if step["id"] == "DISCOVERY":
                    step["argv"] = ["./python3", "protected_dummy.py"]
            contract["control_plane"]["discovery"]["producer_path"] = "protected_dummy.py"
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(
                contract
            )
            with self.assertRaisesRegex(
                ValueError,
                "producer_path must appear in the producer step argv",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-forged-exact-python3-producer",
                )

    def test_producer_rejects_candidate_named_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            contract, proposal, _ = self.make_case(workspace)
            spoof = workspace / "env"
            spoof.write_text(
                "#!/bin/sh\n"
                "# ignore interpreter/script operands and forge discovery\n"
                "printf '%s' 'forged' > discovery.json\n",
                encoding="utf-8",
            )
            spoof.chmod(0o755)
            dummy = workspace / "protected_dummy.py"
            dummy.write_text("# not executed\n", encoding="utf-8")
            contract["scope"]["editable"] = ["candidate.txt", "env"]
            contract["candidate_capabilities"]["writable_paths"] = [
                "candidate.txt",
                "env",
            ]
            contract["control_plane"]["candidate_artifacts"] = [
                "candidate.txt",
                "env",
            ]
            contract["scope"]["protected"] = [
                "runner.py",
                "protected.txt",
                "protected_dummy.py",
            ]
            contract["control_plane"]["protected_assets"] = [
                {
                    "path": "runner.py",
                    "fingerprint": vdd_accept.file_fingerprint(workspace / "runner.py"),
                },
                {
                    "path": "protected.txt",
                    "fingerprint": vdd_accept.file_fingerprint(
                        workspace / "protected.txt"
                    ),
                },
                {
                    "path": "protected_dummy.py",
                    "fingerprint": vdd_accept.file_fingerprint(dummy),
                },
            ]
            for step in contract["control_plane"]["execution_plan"]:
                if step["id"] == "DISCOVERY":
                    # Candidate env + trusted interpreter basename + protected dummy.
                    step["argv"] = ["./env", "python3", "protected_dummy.py"]
            contract["control_plane"]["discovery"]["producer_path"] = "protected_dummy.py"
            execution_environment = {
                name: os.environ[name]
                for name in contract["control_plane"]["environment_allowlist"]
            }
            env = vdd_accept.derive_environment_identity(
                execution_environment,
                contract["control_plane"]["execution_plan"],
                workspace,
            )
            contract["environment"]["digest"] = env["digest"]
            proposal["environment"] = copy.deepcopy(env)
            proposal["contract"]["fingerprint"] = vdd_accept.contract_fingerprint(
                contract
            )
            with self.assertRaisesRegex(
                ValueError,
                "producer_path must appear in the producer step argv",
            ):
                vdd_accept.issue_attestation(
                    contract,
                    proposal,
                    workspace=workspace,
                    signing_key=b"control-plane-secret",
                    run_id="run-forged-exact-env-producer",
                )





if __name__ == "__main__":
    unittest.main()
