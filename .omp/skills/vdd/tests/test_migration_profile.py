from __future__ import annotations

import copy
import importlib.util
import json
import sys
from unittest import mock
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("vdd_lint", ROOT / "tools" / "vdd_lint.py")
assert SPEC and SPEC.loader
vdd_lint = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = vdd_lint
SPEC.loader.exec_module(vdd_lint)
ACCEPT_SPEC = importlib.util.spec_from_file_location("vdd_accept", ROOT / "tools" / "vdd_accept.py")
assert ACCEPT_SPEC and ACCEPT_SPEC.loader
vdd_accept = importlib.util.module_from_spec(ACCEPT_SPEC)
sys.modules[ACCEPT_SPEC.name] = vdd_accept
ACCEPT_SPEC.loader.exec_module(vdd_accept)


def load(relative: str) -> dict:
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def digest(character: str) -> str:
    return "sha256:" + character * 64


def migration_context(*, role: str = "batch") -> dict:
    context = {
        "program_id": "MIG-CLI-001",
        "role": role,
        "program_generation": digest("1"),
        "source_reference": {
            "revision": "git:legacy@9f31",
            "inventory_digest": digest("2"),
            "baseline_digest": digest("3"),
        },
        "dependency_graph_digest": digest("4"),
        "gap_inventory_digest": digest("5"),
        "migration_artifact": {
            "kind": "rulebook",
            "revision": "rulebook@1",
            "digest": digest("6"),
        },
        "source_classification": {
            "revision": "source-classification@1",
            "digest": digest("a"),
        },
        "impact_index": {
            "digest": digest("7"),
            "soundness": "conservative-transitive",
            "unknown_link_policy": "invalidate",
        },
        "candidate_snapshot_digest": digest("8"),
    }
    if role == "batch":
        context["batch"] = {
            "id": "B-0001",
            "manifest_digest": digest("9"),
            "lease_generation": 1,
            "attempt": 1,
            "candidate_base_digest": digest("8"),
            "fencing": {
                "authority": "missions-runtime",
                "record_digest": digest("b"),
                "batch_id": "B-0001",
                "lease_generation": 1,
                "attempt": 1,
                "candidate_base_digest": digest("8"),
                "submitted_snapshot_digest": digest("8"),
            },
        }
    return context


def migration_evidence(context: dict, *, parents: list[dict] | None = None) -> dict:
    payload = {
        "program_id": context["program_id"],
        "role": context["role"],
        "program_generation": context["program_generation"],
        "context_fingerprint": vdd_lint.canonical_fingerprint(context),
        "source_reference": copy.deepcopy(context["source_reference"]),
        "source_inventory": {
            "scan_digest": context["source_reference"]["inventory_digest"],
            "expected": 3,
            "discovered": 3,
            "unit_ids": ["U-001", "U-002", "U-003"],
        },
        "dependency_graph_digest": context["dependency_graph_digest"],
        "gap_inventory_digest": context["gap_inventory_digest"],
        "migration_artifact": copy.deepcopy(context["migration_artifact"]),
        "source_classification": copy.deepcopy(context["source_classification"]),
        "impact_index": copy.deepcopy(context["impact_index"]),
        "candidate_snapshot_digest": context["candidate_snapshot_digest"],
        "parents": parents or [],
    }
    if context["role"] == "batch":
        payload["batch"] = copy.deepcopy(context["batch"])
    return payload


class LargeEquivalenceMigrationProfileTests(unittest.TestCase):
    def _sign(self, evidence: dict) -> dict:
        control_plane = evidence.setdefault("control_plane", {})
        control_plane.update(
            {
                "issuer": "vdd_accept",
                "run_id": evidence["attestation_id"],
                "protected_snapshot_before": [],
                "protected_snapshot_after": [],
                "candidate_snapshot_before": [],
                "candidate_snapshot_after": [],
                "discovery_digest": digest("a"),
                "qualification_snapshots": [],
                "parent_snapshot": None,
                "migration_parent_snapshots": [],
                "attestation_digest": "",
                "signature": "pending",
            }
        )
        control_plane["attestation_digest"] = vdd_accept.attestation_digest(evidence)
        control_plane["signature"] = vdd_accept.sign_attestation(evidence, b"migration-key")
        return evidence

    def make_batch_pair(self) -> tuple[dict, dict]:
        contract = load("examples/standard-equivalence/contract.json")
        evidence = load("examples/standard-equivalence/evidence.json")
        context = migration_context()
        contract["migration_profile"] = "large_equivalence"
        contract["migration_context"] = context
        control_plane = contract.setdefault("control_plane", {})
        control_plane["migration_fencing_result"] = {
            "command_id": "MIGRATION-FENCING",
            "result_path": "artifacts/migration-fencing.json",
            "producer_path": "verifier/migration_fencing.py",
        }
        control_plane["migration_completion_result"] = {
            "command_id": "MIGRATION-COMPLETION",
            "result_path": "artifacts/migration-completion.json",
            "producer_path": "verifier/migration_completion.py",
        }
        control_plane.setdefault("protected_assets", []).extend(
            [
                {"path": "verifier/migration_fencing.py", "fingerprint": digest("b")},
                {"path": "verifier/migration_completion.py", "fingerprint": digest("c")},
            ]
        )
        evidence["stage"] = "batch"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-BOOTSTRAP",
                    "digest": digest("b"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                }
            ],
        )
        evidence["candidate"]["revision"] = context["candidate_snapshot_digest"]
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        return contract, evidence

    def test_batch_profile_accepts_bound_bootstrap_parent(self):
        contract, evidence = self.make_batch_pair()
        self.assertEqual([], vdd_lint.validate_contract(contract).errors)
        self.assertEqual([], vdd_lint.validate_evidence(evidence, contract).errors)

    def test_batch_profile_rejects_snapshot_or_parent_mismatch(self):
        contract, evidence = self.make_batch_pair()
        evidence["migration"]["candidate_snapshot_digest"] = digest("d")
        evidence["migration"]["parents"][0]["stage"] = "completion"
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("candidate_snapshot_digest" in error for error in result.errors),
            result.errors,
        )
        self.assertTrue(
            any("invalid parent stages" in error for error in result.errors),
            result.errors,
        )

    def test_batch_requires_equivalence_evidence(self):
        contract, evidence = self.make_batch_pair()
        evidence["mode_evidence"] = {}
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("equivalence reference GREEN evidence" in error for error in result.errors),
            result.errors,
        )
        self.assertTrue(
            any("equivalence parity evidence" in error for error in result.errors),
            result.errors,
        )

    def test_profile_requires_migration_snapshot_to_match_candidate_identity(self):
        contract, evidence = self.make_batch_pair()
        evidence["candidate"]["revision"] = digest("d")
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("candidate_snapshot_digest differs" in error for error in result.errors),
            result.errors,
        )

    def test_migration_release_uses_cutover_parent_not_legacy_merge_parent(self):
        contract, evidence = self.make_batch_pair()
        context = migration_context(role="release")
        contract["migration_context"] = context
        evidence["stage"] = "release"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-CUTOVER",
                    "digest": digest("b"),
                    "stage": "cutover",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                }
            ],
        )
        evidence["candidate"]["revision"] = context["candidate_snapshot_digest"]
        evidence["parent_attestation"] = None
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertFalse(
            any("parent merge attestation" in error for error in result.errors),
            result.errors,
        )

    def test_bootstrap_requires_independent_protected_inventory_producer(self):
        contract, _ = self.make_batch_pair()
        contract["migration_context"] = migration_context(role="bootstrap")
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("migration_inventory_result" in error for error in result.errors),
            result.errors,
        )

    def test_authenticated_batch_parent_accepts_a_different_stage_contract(self):
        contract, proposal = self.make_batch_pair()
        parent_context = migration_context(role="bootstrap")
        parent = load("examples/standard-equivalence/evidence.json")
        parent.update(
            {
                "attestation_id": "A-BOOTSTRAP",
                "stage": "bootstrap",
                "status": "accepted",
                "migration": migration_evidence(parent_context),
            }
        )
        parent["contract"]["fingerprint"] = digest("c")
        parent["candidate"]["revision"] = parent_context["candidate_snapshot_digest"]
        parent = self._sign(parent)
        proposal["migration"]["parents"] = [
            {
                "attestation_id": parent["attestation_id"],
                "digest": vdd_accept.attestation_digest(parent),
                "stage": "bootstrap",
                "status": "accepted",
                "contract_fingerprint": parent["contract"]["fingerprint"],
                "candidate_revision": parent["candidate"]["revision"],
            }
        ]
        with mock.patch.object(vdd_accept, "_validate_schema"), mock.patch.object(
            vdd_accept, "_require_unexpired_residuals"
        ):
            parents, candidate_digests = vdd_accept._authenticate_migration_parents(
                contract, proposal, [parent], b"migration-key"
            )
        self.assertEqual(["A-BOOTSTRAP"], [item["attestation_id"] for item in parents])
        self.assertEqual([], candidate_digests)

    def test_batch_accepts_preceding_batch_parent(self):
        contract, evidence = self.make_batch_pair()
        parent = copy.deepcopy(evidence)
        parent["attestation_id"] = "A-BATCH-0000"
        parent["migration"]["parents"] = [
            {
                "attestation_id": "A-BOOTSTRAP",
                "digest": digest("b"),
                "stage": "bootstrap",
                "status": "accepted",
                "contract_fingerprint": digest("c"),
                "candidate_revision": parent["candidate"]["revision"],
            }
        ]
        parent = self._sign(parent)
        evidence["migration"]["parents"] = [
            {
                "attestation_id": parent["attestation_id"],
                "digest": vdd_accept.attestation_digest(parent),
                "stage": "batch",
                "status": "accepted",
                "contract_fingerprint": parent["contract"]["fingerprint"],
                "candidate_revision": parent["candidate"]["revision"],
            }
        ]
        with mock.patch.object(vdd_accept, "_validate_schema"), mock.patch.object(
            vdd_accept, "_require_unexpired_residuals"
        ):
            parents, _ = vdd_accept._authenticate_migration_parents(
                contract, evidence, [parent], b"migration-key"
            )
        self.assertEqual(["A-BATCH-0000"], [item["attestation_id"] for item in parents])

    def test_contract_accepts_delta_catalog_for_same_stack_uplift(self):
        contract, _ = self.make_batch_pair()
        contract["migration_context"]["migration_artifact"]["kind"] = "delta_catalog"
        contract["migration_context"]["migration_artifact"]["revision"] = "delta-catalog@1"
        result = vdd_lint.validate_contract(contract)
        self.assertEqual([], result.errors, result.errors)

    def test_batch_rejects_fencing_snapshot_mismatch(self):
        contract, evidence = self.make_batch_pair()
        evidence["migration"]["batch"]["fencing"]["submitted_snapshot_digest"] = digest("d")
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("submitted_snapshot_digest" in error for error in result.errors),
            result.errors,
        )

    def test_batch_requires_base_snapshot_to_match_bootstrap_parent(self):
        contract, proposal = self.make_batch_pair()
        parent_context = migration_context(role="bootstrap")
        parent = load("examples/standard-equivalence/evidence.json")
        parent.update(
            {
                "attestation_id": "A-BOOTSTRAP",
                "stage": "bootstrap",
                "status": "accepted",
                "migration": migration_evidence(parent_context),
            }
        )
        parent["contract"]["fingerprint"] = digest("c")
        parent["candidate"]["revision"] = parent_context["candidate_snapshot_digest"]
        parent = self._sign(parent)
        proposal["migration"]["parents"] = [
            {
                "attestation_id": parent["attestation_id"],
                "digest": vdd_accept.attestation_digest(parent),
                "stage": "bootstrap",
                "status": "accepted",
                "contract_fingerprint": parent["contract"]["fingerprint"],
                "candidate_revision": parent["candidate"]["revision"],
            }
        ]
        proposal["migration"]["batch"]["candidate_base_digest"] = digest("d")
        with mock.patch.object(vdd_accept, "_validate_schema"), mock.patch.object(
            vdd_accept, "_require_unexpired_residuals"
        ):
            with self.assertRaisesRegex(ValueError, "candidate_base_digest differs"):
                vdd_accept._authenticate_migration_parents(
                    contract, proposal, [parent], b"migration-key"
                )

    def test_authenticated_parent_requires_exact_proposal_reference(self):
        contract, proposal = self.make_batch_pair()
        parent_context = migration_context(role="bootstrap")
        parent = load("examples/standard-equivalence/evidence.json")
        parent.update(
            {
                "attestation_id": "A-BOOTSTRAP",
                "stage": "bootstrap",
                "status": "accepted",
                "migration": migration_evidence(parent_context),
            }
        )
        parent["contract"]["fingerprint"] = digest("c")
        parent["candidate"]["revision"] = parent_context["candidate_snapshot_digest"]
        parent = self._sign(parent)
        proposal["migration"]["parents"] = [
            {
                "attestation_id": parent["attestation_id"],
                "digest": digest("d"),
                "stage": "bootstrap",
                "status": "accepted",
                "contract_fingerprint": parent["contract"]["fingerprint"],
                "candidate_revision": parent["candidate"]["revision"],
            }
        ]
        with mock.patch.object(vdd_accept, "_validate_schema"), mock.patch.object(
            vdd_accept, "_require_unexpired_residuals"
        ):
            with self.assertRaisesRegex(
                ValueError, "proposal migration parent references differ"
            ):
                vdd_accept._authenticate_migration_parents(
                    contract, proposal, [parent], b"migration-key"
                )

    def test_batch_requires_protected_runtime_fencing_producer(self):
        contract, _ = self.make_batch_pair()
        del contract["control_plane"]["migration_fencing_result"]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("migration_fencing_result" in error for error in result.errors),
            result.errors,
        )

    def test_batch_rejects_missing_or_extra_parent_stage(self):
        contract, evidence = self.make_batch_pair()
        evidence["migration"]["parents"].append(
            {
                "attestation_id": "A-COMPLETION",
                "digest": digest("e"),
                "stage": "completion",
                "status": "accepted",
                "contract_fingerprint": digest("f"),
                "candidate_revision": "completion-candidate",
            }
        )
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("invalid parent stages" in error for error in result.errors),
            result.errors,
        )

    def test_completion_rejects_disposition_digest_that_does_not_bind_dispositions(self):
        contract, evidence = self.make_batch_pair()
        context = migration_context(role="completion")
        contract["migration_context"] = context
        evidence["stage"] = "completion"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-BOOTSTRAP",
                    "digest": digest("b"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
                {
                    "attestation_id": "A-BATCH-0001",
                    "digest": digest("d"),
                    "stage": "batch",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
            ],
        )
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        evidence["migration"]["completion"] = {
            "expected": 3,
            "accepted": 3,
            "excluded": 0,
            "blocked": 0,
            "unresolved": 0,
            "unknown": 0,
            "disposition_digest": digest("f"),
            "batch_attestations": [
                {"attestation_id": "A-BATCH-0001", "digest": digest("d")}
            ],
            "impact_index_digest": context["impact_index"]["digest"],
            "unresolved_impact_links": 0,
            "integration_snapshot_digest": context["candidate_snapshot_digest"],
            "dispositions": [
                {"unit_id": "U-001", "status": "accepted"},
                {"unit_id": "U-002", "status": "accepted"},
                {"unit_id": "U-003", "status": "accepted"},
            ],
        }
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("disposition_digest differs from dispositions" in error for error in result.errors),
            result.errors,
        )

    def test_completion_requires_protected_reconciliation_producer(self):
        contract, _ = self.make_batch_pair()
        contract["migration_context"] = migration_context(role="completion")
        del contract["control_plane"]["migration_completion_result"]
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("migration_completion_result" in error for error in result.errors),
            result.errors,
        )

    def test_completion_rejects_blocked_or_omitted_authenticated_batches(self):
        contract, evidence = self.make_batch_pair()
        context = migration_context(role="completion")
        contract["migration_context"] = context
        evidence["stage"] = "completion"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-BOOTSTRAP",
                    "digest": digest("b"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
                {
                    "attestation_id": "A-BATCH-0001",
                    "digest": digest("d"),
                    "stage": "batch",
                    "status": "accepted",
                    "contract_fingerprint": digest("e"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
                {
                    "attestation_id": "A-BATCH-0002",
                    "digest": digest("e"),
                    "stage": "batch",
                    "status": "accepted",
                    "contract_fingerprint": digest("f"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
            ],
        )
        evidence["migration"]["completion"] = {
            "expected": 3,
            "accepted": 2,
            "excluded": 0,
            "blocked": 1,
            "unresolved": 0,
            "unknown": 0,
            "disposition_digest": digest("f"),
            "batch_attestations": [
                {"attestation_id": "A-BATCH-0001", "digest": digest("d")}
            ],
            "impact_index_digest": context["impact_index"]["digest"],
            "unresolved_impact_links": 0,
            "integration_snapshot_digest": context["candidate_snapshot_digest"],
            "dispositions": [
                {"unit_id": "U-001", "status": "accepted"},
                {"unit_id": "U-002", "status": "accepted"},
                {"unit_id": "U-003", "status": "blocked"},
            ],
        }
        evidence["migration"]["completion"]["disposition_digest"] = (
            vdd_lint.canonical_fingerprint(
                evidence["migration"]["completion"]["dispositions"]
            )
        )
        evidence["candidate"]["revision"] = context["candidate_snapshot_digest"]
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("zero blocked" in error for error in result.errors), result.errors
        )
        self.assertTrue(
            any("exactly match" in error for error in result.errors), result.errors
        )

    def test_completion_rejects_multiple_bootstrap_parents(self):
        contract, evidence = self.make_batch_pair()
        context = migration_context(role="completion")
        contract["migration_context"] = context
        evidence["stage"] = "completion"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-BOOTSTRAP-1",
                    "digest": digest("b"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
                {
                    "attestation_id": "A-BOOTSTRAP-2",
                    "digest": digest("d"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("e"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
                {
                    "attestation_id": "A-BATCH-0001",
                    "digest": digest("f"),
                    "stage": "batch",
                    "status": "accepted",
                    "contract_fingerprint": digest("1"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
            ],
        )
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("exactly one bootstrap" in error for error in result.errors),
            result.errors,
        )

    def test_completion_rejects_count_that_differs_from_source_inventory(self):
        contract, evidence = self.make_batch_pair()
        context = migration_context(role="completion")
        contract["migration_context"] = context
        evidence["stage"] = "completion"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-BOOTSTRAP",
                    "digest": digest("b"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
                {
                    "attestation_id": "A-BATCH-0001",
                    "digest": digest("d"),
                    "stage": "batch",
                    "status": "accepted",
                    "contract_fingerprint": digest("e"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
            ],
        )
        evidence["migration"]["source_inventory"]["expected"] = 3
        evidence["migration"]["source_inventory"]["discovered"] = 3
        evidence["migration"]["completion"] = {
            "expected": 1,
            "accepted": 1,
            "excluded": 0,
            "blocked": 0,
            "unresolved": 0,
            "unknown": 0,
            "disposition_digest": digest("f"),
            "batch_attestations": [
                {"attestation_id": "A-BATCH-0001", "digest": digest("d")}
            ],
            "impact_index_digest": context["impact_index"]["digest"],
            "unresolved_impact_links": 0,
            "integration_snapshot_digest": context["candidate_snapshot_digest"],
            "dispositions": [{"unit_id": "U-001", "status": "accepted"}],
        }
        evidence["migration"]["completion"]["disposition_digest"] = (
            vdd_lint.canonical_fingerprint(
                evidence["migration"]["completion"]["dispositions"]
            )
        )
        evidence["candidate"]["revision"] = context["candidate_snapshot_digest"]
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("protected inventory closure" in error for error in result.errors),
            result.errors,
        )

    def test_completion_producer_cannot_reuse_a_stability_command(self):
        contract, _ = self.make_batch_pair()
        contract["migration_context"] = migration_context(role="completion")
        contract["control_plane"]["migration_completion_result"]["command_id"] = (
            "QUAL-DIFF-STABILITY-1"
        )
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("overlap non-stability control-plane roles" in error for error in result.errors),
            result.errors,
        )

    def test_profile_requires_source_classification_identity(self):
        contract, _ = self.make_batch_pair()
        contract["migration_context"].pop("source_classification", None)
        result = vdd_lint.validate_contract(contract)
        self.assertTrue(
            any("source_classification" in error for error in result.errors),
            result.errors,
        )

    def test_authenticated_parent_requires_matching_source_reference(self):
        contract, proposal = self.make_batch_pair()
        parent_context = migration_context(role="bootstrap")
        parent = load("examples/standard-equivalence/evidence.json")
        parent.update(
            {
                "attestation_id": "A-BOOTSTRAP",
                "stage": "bootstrap",
                "status": "accepted",
                "migration": migration_evidence(parent_context),
            }
        )
        parent["migration"]["source_reference"]["revision"] = "git:other@9f31"
        parent["contract"]["fingerprint"] = digest("c")
        parent["candidate"]["revision"] = parent_context["candidate_snapshot_digest"]
        parent = self._sign(parent)
        proposal["migration"]["parents"] = [
            {
                "attestation_id": parent["attestation_id"],
                "digest": vdd_accept.attestation_digest(parent),
                "stage": "bootstrap",
                "status": "accepted",
                "contract_fingerprint": parent["contract"]["fingerprint"],
                "candidate_revision": parent["candidate"]["revision"],
            }
        ]
        with mock.patch.object(vdd_accept, "_validate_schema"), mock.patch.object(
            vdd_accept, "_require_unexpired_residuals"
        ):
            with self.assertRaisesRegex(ValueError, "source_reference differs"):
                vdd_accept._authenticate_migration_parents(
                    contract, proposal, [parent], b"migration-key"
                )

    def test_completion_rejects_exclusion_without_named_decision(self):
        contract, evidence = self.make_batch_pair()
        context = migration_context(role="completion")
        contract["migration_context"] = context
        evidence["stage"] = "completion"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-BOOTSTRAP",
                    "digest": digest("b"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
                {
                    "attestation_id": "A-BATCH-0001",
                    "digest": digest("d"),
                    "stage": "batch",
                    "status": "accepted",
                    "contract_fingerprint": digest("e"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
            ],
        )
        evidence["migration"]["completion"] = {
            "expected": 3,
            "accepted": 2,
            "excluded": 1,
            "blocked": 0,
            "unresolved": 0,
            "unknown": 0,
            "disposition_digest": digest("f"),
            "batch_attestations": [
                {"attestation_id": "A-BATCH-0001", "digest": digest("d")}
            ],
            "impact_index_digest": context["impact_index"]["digest"],
            "unresolved_impact_links": 0,
            "integration_snapshot_digest": context["candidate_snapshot_digest"],
            "dispositions": [
                {"unit_id": "U-001", "status": "accepted"},
                {"unit_id": "U-002", "status": "accepted"},
                {"unit_id": "U-003", "status": "excluded"},
            ],
        }
        evidence["migration"]["completion"]["disposition_digest"] = (
            vdd_lint.canonical_fingerprint(
                evidence["migration"]["completion"]["dispositions"]
            )
        )
        evidence["candidate"]["revision"] = context["candidate_snapshot_digest"]
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("named decision" in error for error in result.errors), result.errors
        )

    def test_completion_rejects_integration_snapshot_mismatch(self):
        contract, evidence = self.make_batch_pair()
        context = migration_context(role="completion")
        contract["migration_context"] = context
        evidence["stage"] = "completion"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-BOOTSTRAP",
                    "digest": digest("b"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
                {
                    "attestation_id": "A-BATCH-0001",
                    "digest": digest("d"),
                    "stage": "batch",
                    "status": "accepted",
                    "contract_fingerprint": digest("e"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
            ],
        )
        evidence["migration"]["completion"] = {
            "expected": 3,
            "accepted": 3,
            "excluded": 0,
            "blocked": 0,
            "unresolved": 0,
            "unknown": 0,
            "disposition_digest": digest("f"),
            "batch_attestations": [
                {"attestation_id": "A-BATCH-0001", "digest": digest("d")}
            ],
            "impact_index_digest": context["impact_index"]["digest"],
            "unresolved_impact_links": 0,
            "integration_snapshot_digest": digest("a"),
            "dispositions": [
                {"unit_id": "U-001", "status": "accepted"},
                {"unit_id": "U-002", "status": "accepted"},
                {"unit_id": "U-003", "status": "accepted"},
            ],
        }
        evidence["migration"]["completion"]["disposition_digest"] = (
            vdd_lint.canonical_fingerprint(
                evidence["migration"]["completion"]["dispositions"]
            )
        )
        evidence["candidate"]["revision"] = context["candidate_snapshot_digest"]
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("integration_snapshot_digest" in error for error in result.errors),
            result.errors,
        )

    def test_completion_rejects_unresolved_impact_links_and_unclosed_inventory(self):
        contract, evidence = self.make_batch_pair()
        context = migration_context(role="completion")
        contract["migration_context"] = context
        evidence["stage"] = "completion"
        evidence["migration"] = migration_evidence(
            context,
            parents=[
                {
                    "attestation_id": "A-BOOTSTRAP",
                    "digest": digest("b"),
                    "stage": "bootstrap",
                    "status": "accepted",
                    "contract_fingerprint": digest("c"),
                    "candidate_revision": "bootstrap-candidate",
                },
                {
                    "attestation_id": "A-BATCH-0001",
                    "digest": digest("d"),
                    "stage": "batch",
                    "status": "accepted",
                    "contract_fingerprint": digest("e"),
                    "candidate_revision": context["candidate_snapshot_digest"],
                },
            ],
        )
        evidence["migration"]["completion"] = {
            "expected": 3,
            "accepted": 2,
            "excluded": 0,
            "blocked": 0,
            "unresolved": 1,
            "unknown": 0,
            "disposition_digest": digest("f"),
            "batch_attestations": [
                {"attestation_id": "A-BATCH-0001", "digest": digest("d")}
            ],
            "impact_index_digest": context["impact_index"]["digest"],
            "unresolved_impact_links": 1,
            "integration_snapshot_digest": context["candidate_snapshot_digest"],
            "dispositions": [
                {"unit_id": "U-001", "status": "accepted"},
                {"unit_id": "U-002", "status": "accepted"},
                {"unit_id": "U-003", "status": "unresolved"},
            ],
        }
        evidence["migration"]["completion"]["disposition_digest"] = (
            vdd_lint.canonical_fingerprint(
                evidence["migration"]["completion"]["dispositions"]
            )
        )
        evidence["contract"]["fingerprint"] = vdd_lint.contract_fingerprint(contract)
        result = vdd_lint.validate_evidence(evidence, contract)
        self.assertTrue(
            any("inventory closure" in error for error in result.errors),
            result.errors,
        )
        self.assertTrue(
            any("unresolved impact links" in error for error in result.errors),
            result.errors,
        )


if __name__ == "__main__":
    unittest.main()
