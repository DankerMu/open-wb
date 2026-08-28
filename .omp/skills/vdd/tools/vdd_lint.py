#!/usr/bin/env python3
"""Reference linter for VDD 0.4 JSON contracts and attestations.

This tool applies Draft 2020-12 JSON Schema and semantic protocol invariants; it does
not prove software behavior.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import re
import sys
from datetime import datetime
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from jsonschema import Draft202012Validator

MODES = {"characterization", "construction", "equivalence", "improvement"}
RISKS = {"light", "standard", "critical"}
SEVERITIES = {"low", "medium", "high", "critical"}
QUALITY = {"low", "medium", "high"}
COMMAND_RESULTS = {"pass", "expected_reject", "fail", "blocked"}
MIGRATION_STAGES = {"bootstrap", "batch", "completion", "cutover", "release"}
MIGRATION_ROLES = {"bootstrap", "batch", "completion", "cutover", "release"}
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")



def canonical_fingerprint(value: Any, *, omit_keys: Iterable[str] = ()) -> str:
    omitted = set(omit_keys)

    def normalize(item: Any) -> Any:
        if isinstance(item, dict):
            return {
                key: normalize(child)
                for key, child in sorted(item.items())
                if key not in omitted
            }
        if isinstance(item, list):
            return [normalize(child) for child in item]
        return item

    encoded = json.dumps(
        normalize(value),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def contract_fingerprint(contract: dict[str, Any]) -> str:
    return canonical_fingerprint(contract)


@dataclass
class LintResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def _nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())

def _is_digest(value: Any) -> bool:
    return isinstance(value, str) and DIGEST_RE.fullmatch(value) is not None



def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}

def runtime_platform_identity() -> dict[str, str]:
    system = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(
        platform.system(), platform.system().lower()
    )
    machine = {"aarch64": "arm64", "amd64": "x86_64"}.get(
        platform.machine().lower(), platform.machine().lower()
    )
    return {"platform_id": f"{system}-{machine}"}


def _relative_path_parts(value: Any) -> tuple[str, ...] | None:
    if not _nonempty(value) or "\\" in value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        return None
    return tuple(part for part in path.parts if part != ".")


def _path_within(child: Any, parent: Any) -> bool:
    child_parts = _relative_path_parts(child)
    parent_parts = _relative_path_parts(parent)
    if child_parts is None or parent_parts is None:
        return False
    return child_parts[: len(parent_parts)] == parent_parts


def _numeric_policy(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("%"):
            text = text[:-1].strip()
        try:
            return float(text)
        except ValueError:
            return None
    return None

def _derived_improvement_result(
    baseline_samples: list[Any],
    candidate_samples: list[Any],
    direction: Any,
    noise_band: float | None,
    minimum_change: float | None,
) -> str | None:
    all_samples = baseline_samples + candidate_samples
    if (
        not baseline_samples
        or not candidate_samples
        or any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            for value in all_samples
        )
        or direction not in {"higher", "lower"}
        or noise_band is None
        or minimum_change is None
        or noise_band < 0
        or minimum_change < 0
    ):
        return None
    baseline_mean = sum(baseline_samples) / len(baseline_samples)
    candidate_mean = sum(candidate_samples) / len(candidate_samples)
    if baseline_mean == 0:
        return None
    signed_change = (
        candidate_mean - baseline_mean
        if direction == "higher"
        else baseline_mean - candidate_mean
    )
    relative_change = signed_change / abs(baseline_mean) * 100.0
    if relative_change < -noise_band:
        return "regressed"
    if relative_change > noise_band and relative_change >= minimum_change:
        return "improved"
    return "statistical_inconclusive"

def _timestamp(value: Any) -> datetime | None:
    if not _nonempty(value):
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _unique_ids(items: Iterable[Any], label: str, result: LintResult) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(items):
        if not isinstance(raw, dict):
            result.error(f"{label}[{index}] must be an object")
            continue
        item_id = raw.get("id")
        if not _nonempty(item_id):
            result.error(f"{label}[{index}].id is required")
            continue
        if item_id in found:
            result.error(f"duplicate {label} id: {item_id}")
        found[item_id] = raw
    return found


def _require_fields(obj: dict[str, Any], fields: Iterable[str], prefix: str, result: LintResult) -> None:
    for name in fields:
        if name not in obj:
            result.error(f"{prefix}.{name} is required")


def _validate_migration_contract(contract: dict[str, Any], r: LintResult) -> None:
    """Validate optional large-migration bindings without giving VDD scheduling authority."""
    profile = contract.get("migration_profile", "none")
    context = _dict(contract.get("migration_context"))
    if profile not in {"none", "large_equivalence"}:
        r.error("contract.migration_profile must be none or large_equivalence")
        return
    if profile == "none":
        if context:
            r.error("contract.migration_context requires migration_profile=large_equivalence")
        return

    if contract.get("mode") != "equivalence":
        r.error("large_equivalence migration profile requires equivalence mode")
    if contract.get("risk_profile") not in {"standard", "critical"}:
        r.error("large_equivalence migration profile requires standard or critical risk_profile")
    required = [
        "program_id", "role", "program_generation", "source_reference",
        "dependency_graph_digest", "gap_inventory_digest", "migration_artifact",
        "source_classification", "impact_index", "candidate_snapshot_digest",
    ]
    _require_fields(context, required, "contract.migration_context", r)
    role = context.get("role")
    if role not in MIGRATION_ROLES:
        r.error("contract.migration_context.role must be bootstrap, batch, completion, cutover, or release")
    for name in ["program_generation", "dependency_graph_digest", "gap_inventory_digest", "candidate_snapshot_digest"]:
        if not _is_digest(context.get(name)):
            r.error(f"contract.migration_context.{name} must be a canonical sha256 digest")
    source = _dict(context.get("source_reference"))
    _require_fields(source, ["revision", "inventory_digest", "baseline_digest"], "contract.migration_context.source_reference", r)
    if not _nonempty(source.get("revision")):
        r.error("contract.migration_context.source_reference.revision must be non-empty")
    for name in ["inventory_digest", "baseline_digest"]:
        if not _is_digest(source.get(name)):
            r.error(f"contract.migration_context.source_reference.{name} must be a canonical sha256 digest")
    migration_artifact = _dict(context.get("migration_artifact"))
    _require_fields(
        migration_artifact,
        ["kind", "revision", "digest"],
        "contract.migration_context.migration_artifact",
        r,
    )
    if migration_artifact.get("kind") not in {"rulebook", "delta_catalog", "behavior_catalog"}:
        r.error(
            "contract.migration_context.migration_artifact.kind must be rulebook, delta_catalog, or behavior_catalog"
        )
    if not _nonempty(migration_artifact.get("revision")) or not _is_digest(migration_artifact.get("digest")):
        r.error("contract.migration_context.migration_artifact requires revision and canonical digest")
    source_classification = _dict(context.get("source_classification"))
    _require_fields(
        source_classification,
        ["revision", "digest"],
        "contract.migration_context.source_classification",
        r,
    )
    if (
        not _nonempty(source_classification.get("revision"))
        or not _is_digest(source_classification.get("digest"))
    ):
        r.error(
            "contract.migration_context.source_classification requires revision and canonical digest"
        )
    impact = _dict(context.get("impact_index"))
    _require_fields(impact, ["digest", "soundness", "unknown_link_policy"], "contract.migration_context.impact_index", r)
    if not _is_digest(impact.get("digest")):
        r.error("contract.migration_context.impact_index.digest must be a canonical sha256 digest")
    if impact.get("soundness") != "conservative-transitive":
        r.error("migration impact index must declare conservative-transitive soundness")
    if impact.get("unknown_link_policy") != "invalidate":
        r.error("migration impact index must invalidate unknown links")
    batch = _dict(context.get("batch"))
    if role == "batch":
        _require_fields(batch, ["id", "manifest_digest", "lease_generation", "attempt", "candidate_base_digest", "fencing"], "contract.migration_context.batch", r)
        if not _nonempty(batch.get("id")):
            r.error("contract.migration_context.batch.id must be non-empty")
        for name in ["manifest_digest", "candidate_base_digest"]:
            if not _is_digest(batch.get(name)):
                r.error(f"contract.migration_context.batch.{name} must be a canonical sha256 digest")
        for name in ["lease_generation", "attempt"]:
            if not isinstance(batch.get(name), int) or isinstance(batch.get(name), bool) or batch.get(name) < 1:
                r.error(f"contract.migration_context.batch.{name} must be a positive integer")
        fencing = _dict(batch.get("fencing"))
        _require_fields(
            fencing,
            ["authority", "record_digest", "batch_id", "lease_generation", "attempt", "candidate_base_digest", "submitted_snapshot_digest"],
            "contract.migration_context.batch.fencing",
            r,
        )
        if not _nonempty(fencing.get("authority")) or not _nonempty(fencing.get("batch_id")):
            r.error("migration batch fencing requires non-empty authority and batch_id")
        for name in ["record_digest", "submitted_snapshot_digest"]:
            if not _is_digest(fencing.get(name)):
                r.error(
                    f"migration batch fencing {name} must be a canonical sha256 digest"
                )
        for name in ["lease_generation", "attempt"]:
            if not isinstance(fencing.get(name), int) or isinstance(fencing.get(name), bool) or fencing.get(name) < 1:
                r.error(f"migration batch fencing {name} must be a positive integer")
        if fencing.get("batch_id") != batch.get("id"):
            r.error("migration batch fencing batch_id differs from batch id")
        for name in ["lease_generation", "attempt", "candidate_base_digest"]:
            if fencing.get(name) != batch.get(name):
                r.error(f"migration batch fencing {name} differs from batch")
    elif batch:
        r.error("contract.migration_context.batch is valid only for batch role")


def validate_contract(contract: dict[str, Any]) -> LintResult:
    r = LintResult()
    _require_fields(
        contract,
        [
            "schema_version", "revision", "objective_id", "mode", "risk_profile", "goal",
            "intent", "claims", "defeaters", "oracles", "fixtures", "baseline", "scope",
            "candidate_capabilities", "roles", "environment", "test_discovery", "gates",
            "cutover", "evidence", "runtime_feedback", "stop_conditions",
        ],
        "contract",
        r,
    )

    if contract.get("schema_version") != "vdd-0.4":
        r.error("contract.schema_version must be 'vdd-0.4'")
    if not _nonempty(contract.get("revision")):
        r.error("contract.revision must be non-empty")
    if not _nonempty(contract.get("objective_id")):
        r.error("contract.objective_id must be non-empty")
    if not _nonempty(contract.get("goal")):
        r.error("contract.goal must be non-empty")

    mode = contract.get("mode")
    risk = contract.get("risk_profile")
    if mode not in MODES:
        r.error(f"contract.mode must be one of {sorted(MODES)}")
    if risk not in RISKS:
        r.error(f"contract.risk_profile must be one of {sorted(RISKS)}")

    intent = _dict(contract.get("intent"))
    _require_fields(
        intent,
        ["status", "owner", "authority", "sources", "positive_examples", "negative_examples",
         "critical_scenarios", "ambiguities", "unknowns", "decisions"],
        "contract.intent",
        r,
    )
    if intent.get("status") not in {"validated", "spec_dispute", "blocked"}:
        r.error("contract.intent.status must be validated, spec_dispute, or blocked")
    if mode in {"construction", "equivalence", "improvement"} and intent.get("status") != "validated":
        r.error(f"{mode} requires validated intent")
    if mode == "characterization" and intent.get("status") in {"spec_dispute", "blocked"}:
        r.warn("characterization intent is unresolved; the contract may only document the blocker")
    if not _nonempty(intent.get("owner")):
        r.error("contract.intent.owner must be non-empty")
    if not _nonempty(intent.get("authority")):
        r.error("contract.intent.authority must be non-empty")

    claims = _unique_ids(_list(contract.get("claims")), "claims", r)
    defeaters = _unique_ids(_list(contract.get("defeaters")), "defeaters", r)
    oracles = _unique_ids(_list(contract.get("oracles")), "oracles", r)
    if not claims:
        r.error("contract.claims must contain at least one claim")
    if not oracles:
        r.error("contract.oracles must contain at least one oracle")

    for cid, claim in claims.items():
        if not _nonempty(claim.get("statement")):
            r.error(f"claim {cid} requires a statement")
        if not _nonempty(claim.get("scope")):
            r.error(f"claim {cid} requires an observable scope")
        severity = claim.get("severity")
        if severity not in SEVERITIES:
            r.error(f"claim {cid}.severity must be one of {sorted(SEVERITIES)}")
        oracle_ids = _list(claim.get("oracle_ids"))
        defeater_ids = _list(claim.get("defeater_ids"))
        if not oracle_ids:
            r.error(f"claim {cid} must reference at least one oracle")
        for oid in oracle_ids:
            if oid not in oracles:
                r.error(f"claim {cid} references unknown oracle {oid}")
        for did in defeater_ids:
            if did not in defeaters:
                r.error(f"claim {cid} references unknown defeater {did}")
            elif defeaters[did].get("claim_id") != cid:
                r.error(
                    f"claim {cid} references defeater {did}, which belongs to claim "
                    f"{defeaters[did].get('claim_id')}"
                )
        if risk in {"standard", "critical"} and severity in {"high", "critical"} and not defeater_ids:
            r.error(f"{risk} claim {cid} ({severity}) requires at least one defeater")
        elif severity in {"high", "critical"} and not defeater_ids:
            r.warn(f"high-severity claim {cid} has no explicit defeater")

    covered_defeaters: set[str] = set()
    for did, defeater in defeaters.items():
        claim_id = defeater.get("claim_id")
        if claim_id not in claims:
            r.error(f"defeater {did} references unknown claim {claim_id}")
        elif did not in _list(claims[claim_id].get("defeater_ids")):
            r.error(f"defeater {did} is not linked from owning claim {claim_id}")
        severity = defeater.get("severity")
        if severity not in SEVERITIES:
            r.error(f"defeater {did}.severity must be one of {sorted(SEVERITIES)}")
        status = defeater.get("status")
        if status not in {"covered", "accepted_residual", "unknown"}:
            r.error(f"defeater {did}.status must be covered, accepted_residual, or unknown")
        oracle_ids = _list(defeater.get("oracle_ids"))
        for oid in oracle_ids:
            if oid not in oracles:
                r.error(f"defeater {did} references unknown oracle {oid}")
        if status == "covered":
            covered_defeaters.add(did)
            if not oracle_ids:
                r.error(f"covered defeater {did} must reference an oracle")
            if not _nonempty(defeater.get("qualification_fault")):
                r.error(f"covered defeater {did} requires a discriminating qualification_fault")
        elif status == "accepted_residual":
            acceptance = _dict(defeater.get("risk_acceptance"))
            if not acceptance:
                r.error(f"accepted residual defeater {did} requires risk_acceptance")
            else:
                if not _nonempty(acceptance.get("owner")):
                    r.error(f"defeater {did} risk_acceptance.owner must be non-empty")
                stages = _list(acceptance.get("stages"))
                if not stages or any(
                    stage not in {
                        "characterization", "bootstrap", "batch", "completion",
                        "cutover", "merge", "release",
                    }
                    for stage in stages
                ):
                    r.error(f"defeater {did} risk_acceptance.stages must name valid stages")
                if not _nonempty(acceptance.get("expires_at")):
                    r.error(f"defeater {did} risk_acceptance.expires_at must be non-empty")
                elif _timestamp(acceptance.get("expires_at")) is None:
                    r.error(f"defeater {did} risk_acceptance.expires_at must be an ISO-8601 timestamp")
                if not _list(acceptance.get("invalidated_by")):
                    r.error(f"defeater {did} risk_acceptance.invalidated_by must be non-empty")
                if not _nonempty(acceptance.get("rationale")):
                    r.error(f"defeater {did} risk_acceptance.rationale must be non-empty")
        elif status == "unknown":
            r.warn(f"defeater {did} remains unknown and will block accepted evidence unless the contract is narrowed")

    known_bad_coverage: set[str] = set()
    for oid, oracle in oracles.items():
        if not _nonempty(oracle.get("owner")):
            r.error(f"oracle {oid}.owner must be non-empty")
        if not _nonempty(oracle.get("revision")):
            r.error(f"oracle {oid}.revision must be non-empty")
        if not _nonempty(oracle.get("fingerprint")):
            r.error(f"oracle {oid}.fingerprint must be non-empty")
        if risk in {"standard", "critical"} and oracle.get("protected") is not True:
            r.error(f"{risk} oracle {oid} must be protected from candidate writes")
        oracle_claim_ids = _list(oracle.get("claims"))
        if not oracle_claim_ids:
            r.error(f"oracle {oid} must reference at least one claim")
        for cid in oracle_claim_ids:
            if cid not in claims:
                r.error(f"oracle {oid} references unknown claim {cid}")
            elif oid not in _list(claims[cid].get("oracle_ids")):
                r.error(f"oracle {oid} links claim {cid}, but the claim does not link back")
        for cid, claim in claims.items():
            if oid in _list(claim.get("oracle_ids")) and cid not in oracle_claim_ids:
                r.error(f"claim {cid} links oracle {oid}, but the oracle does not link back")
        quality = _dict(oracle.get("quality"))
        for dimension in ["fidelity", "independence", "sensitivity", "reproducibility", "environment_realism"]:
            if quality.get(dimension) not in QUALITY:
                r.error(f"oracle {oid}.quality.{dimension} must be low, medium, or high")
        qualification = _dict(oracle.get("qualification"))
        qualification_status = qualification.get("status", "fresh")
        if qualification_status not in {"fresh", "reused"}:
            r.error(f"oracle {oid}.qualification.status must be fresh or reused")
        bad_cases = _list(qualification.get("known_bad_cases"))
        qualified_here: set[str] = set()
        if qualification_status == "reused":
            if not _nonempty(qualification.get("prior_attestation_id")):
                r.error(f"reused oracle {oid} requires prior_attestation_id")
            if not _nonempty(qualification.get("prior_attestation_digest")):
                r.error(f"reused oracle {oid} requires prior_attestation_digest")
            if qualification.get("qualified_fingerprint") != oracle.get("fingerprint"):
                r.error(f"reused oracle {oid} qualified_fingerprint differs from oracle identity")
            if not _is_digest(qualification.get("qualification_contract_fingerprint")):
                r.error(
                    f"reused oracle {oid} requires a canonical "
                    "qualification_contract_fingerprint"
                )
            if not isinstance(qualification.get("qualification_basis"), dict) or not qualification.get(
                "qualification_basis"
            ):
                r.error(f"reused oracle {oid} requires qualification_basis")
            qualified_here = set(_list(qualification.get("covered_defeater_ids")))
            for did in qualified_here:
                if did not in defeaters:
                    r.error(f"reused oracle {oid} references unknown covered defeater {did}")
                elif oid not in _list(defeaters[did].get("oracle_ids")):
                    r.error(
                        f"reused oracle {oid} covers defeater {did}, but the defeater does not link back"
                    )
                else:
                    known_bad_coverage.add(did)
        else:
            if not _nonempty(qualification.get("known_good_command")):
                r.error(f"oracle {oid} requires qualification.known_good_command")
            if not _nonempty(qualification.get("restore_command")):
                r.error(f"fresh oracle {oid} requires qualification.restore_command")
            if not bad_cases:
                r.error(
                    f"oracle {oid} qualification.known_bad_cases must include at least one case"
                )
            for index, case in enumerate(bad_cases):
                case = _dict(case)
                did = case.get("defeater_id")
                if did not in defeaters:
                    r.error(f"oracle {oid} known_bad_cases[{index}] references unknown defeater {did}")
                else:
                    known_bad_coverage.add(did)
                    qualified_here.add(did)
                    if oid not in _list(defeaters[did].get("oracle_ids")):
                        r.error(
                            f"oracle {oid} qualifies defeater {did}, but the defeater does not link back"
                        )
                if not _nonempty(case.get("fault")) or not _nonempty(case.get("expected_rejection")):
                    r.error(
                        f"oracle {oid} known_bad_cases[{index}] requires fault and expected_rejection"
                    )
        for did, defeater in defeaters.items():
            if (
                defeater.get("status") == "covered"
                and oid in _list(defeater.get("oracle_ids"))
                and did not in qualified_here
            ):
                r.error(f"defeater {did} links oracle {oid}, but the oracle does not qualify it")
        stability_required = qualification.get("stability_required", False)
        if not isinstance(stability_required, bool):
            r.error(f"oracle {oid}.qualification.stability_required must be boolean")
        required_trials = qualification.get(
            "required_no_change_trials",
            qualification.get("no_change_trials", 0),
        )
        if not isinstance(required_trials, int) or required_trials < 0:
            r.error(f"oracle {oid}.qualification.required_no_change_trials must be non-negative")
        elif stability_required and required_trials < 1:
            r.error(f"oracle {oid} requires at least one no-change trial")
        if qualification_status == "fresh":
            stability_command_ids = _list(
                qualification.get("stability_command_ids")
            )
            if len(stability_command_ids) != len(set(stability_command_ids)):
                r.error(
                    f"oracle {oid}.qualification.stability_command_ids must be unique"
                )
            if (
                isinstance(required_trials, int)
                and required_trials > len(stability_command_ids)
            ):
                r.error(
                    f"oracle {oid} requires at least {required_trials} "
                    "stability_command_ids"
                )
        flake = qualification.get("max_flake_rate")
        if not isinstance(flake, (int, float)) or not 0 <= float(flake) <= 1:
            r.error(f"oracle {oid}.qualification.max_flake_rate must be between 0 and 1")
    fixture_names: set[str] = set()
    for index, raw_fixture in enumerate(_list(contract.get("fixtures"))):
        fixture = _dict(raw_fixture)
        name = fixture.get("name")
        fingerprint = fixture.get("fingerprint")
        if not _nonempty(name) or name in fixture_names:
            r.error(f"contract.fixtures[{index}].name must be unique and non-empty")
        else:
            fixture_names.add(name)
        if not _nonempty(fingerprint):
            r.error(f"contract.fixtures[{index}].fingerprint must be non-empty")
    if not fixture_names:
        r.error("contract.fixtures must bind at least one fixture or corpus identity")


    for did in sorted(covered_defeaters - known_bad_coverage):
        r.error(f"covered defeater {did} is not exercised by any oracle known_bad_case")

    baseline = _dict(contract.get("baseline"))
    if mode == "characterization":
        if not (_nonempty(baseline.get("reference_green_command")) or _nonempty(baseline.get("semantic_green_command"))):
            r.error("characterization requires a known-good/reference or semantic GREEN baseline command")
    elif mode == "construction":
        if not _nonempty(baseline.get("semantic_red_command")):
            r.error("construction requires baseline.semantic_red_command")
    elif mode == "equivalence":
        if not _nonempty(baseline.get("reference_green_command")):
            r.error("equivalence requires baseline.reference_green_command")
        cutover = _dict(contract.get("cutover"))
        if cutover.get("strategy") not in {"incremental", "batch", "big-bang"}:
            r.error("equivalence requires cutover.strategy: incremental, batch, or big-bang")
        if not _nonempty(cutover.get("completion")):
            r.error("equivalence requires concrete cutover.completion")
        if not _nonempty(cutover.get("rollback")):
            r.error("equivalence requires cutover.rollback separate from permanent fallback")
    elif mode == "improvement":
        if not _nonempty(baseline.get("semantic_green_command")):
            r.error("improvement requires baseline.semantic_green_command")
        hard_constraints = _list(baseline.get("hard_constraint_commands"))
        if not hard_constraints or any(not _nonempty(item) for item in hard_constraints):
            r.error("improvement requires baseline.hard_constraint_commands")
        elif len(hard_constraints) != len(set(hard_constraints)):
            r.error("improvement baseline.hard_constraint_commands must be unique")
        metric = _dict(baseline.get("metric"))
        for field_name in ["name", "baseline_command"]:
            if not _nonempty(metric.get(field_name)):
                r.error(f"improvement requires baseline.metric.{field_name}")
        if metric.get("direction") not in {"higher", "lower"}:
            r.error("improvement baseline.metric.direction must be higher or lower")
        for field_name in ["noise_band", "minimum_improvement"]:
            value = _numeric_policy(metric.get(field_name))
            if value is None or value < 0:
                r.error(
                    f"improvement requires non-negative numeric baseline.metric.{field_name}"
                )
        runs = metric.get("runs")
        minimum_runs = 5 if risk in {"standard", "critical"} else 3
        if not isinstance(runs, int) or runs < minimum_runs:
            r.error(f"improvement baseline.metric.runs must be >= {minimum_runs} for {risk}")
        if not any(o.get("type") == "benchmark" for o in oracles.values()):
            r.error("improvement requires at least one benchmark oracle")

    scope = _dict(contract.get("scope"))
    if not _list(scope.get("editable")):
        r.error("contract.scope.editable must declare candidate write scope")
    if risk in {"standard", "critical"} and not _list(scope.get("protected")):
        r.error(f"{risk} contract.scope.protected must declare protected judge assets")
    for policy in ["dependency_change_policy", "network_policy", "secret_policy"]:
        if risk in {"standard", "critical"} and not _nonempty(scope.get(policy)):
            r.error(f"{risk} contract.scope.{policy} must be declared")
    capabilities = _dict(contract.get("candidate_capabilities"))
    _require_fields(
        capabilities,
        [
            "writable_paths",
            "readable_protected_paths",
            "allowed_commands",
            "denied_commands",
            "network_policy",
            "secret_policy",
            "dependency_change_policy",
            "destructive_git_policy",
        ],
        "contract.candidate_capabilities",
        r,
    )
    writable_paths = _list(capabilities.get("writable_paths"))
    if not writable_paths:
        r.error("contract.candidate_capabilities.writable_paths must be non-empty")
    editable_paths = _list(scope.get("editable"))
    undeclared_writes = sorted(
        path
        for path in writable_paths
        if not any(_path_within(path, editable) for editable in editable_paths)
    )
    if undeclared_writes:
        r.error(f"candidate writable paths exceed contract scope: {undeclared_writes}")
    if not _list(capabilities.get("allowed_commands")):
        r.error("contract.candidate_capabilities.allowed_commands must be non-empty")
    if capabilities.get("destructive_git_policy") != "deny":
        r.error("contract.candidate_capabilities.destructive_git_policy must be deny")
    for policy in ["network_policy", "secret_policy", "dependency_change_policy"]:
        if not _nonempty(capabilities.get(policy)):
            r.error(f"contract.candidate_capabilities.{policy} must be non-empty")

    roles = _dict(contract.get("roles"))
    for role in ["contract_owner", "verifier_owner", "implementer", "acceptor"]:
        if not _nonempty(roles.get(role)):
            r.error(f"contract.roles.{role} must be non-empty")
    if risk in {"standard", "critical"}:
        if roles.get("verifier_owner") == roles.get("implementer"):
            r.error(f"{risk} verifier_owner must be independent from implementer")
        if roles.get("acceptor") == roles.get("implementer"):
            r.error(f"{risk} acceptor must be independent from implementer")
    if risk == "critical" and not _nonempty(roles.get("release_owner")):
        r.error("critical contract requires roles.release_owner")

    _validate_migration_contract(contract, r)

    environment = _dict(contract.get("environment"))
    if not _nonempty(environment.get("digest")):
        r.error("contract.environment.digest must be non-empty")
    declared_matrix = [
        item for item in _list(environment.get("matrix")) if _nonempty(item)
    ]
    if risk == "critical":
        if not declared_matrix:
            r.error("critical contract environment.matrix must declare supported platforms")
        elif (
            len(declared_matrix) > 1
            and environment.get("platform_evidence_authority")
            != "external-attestation-aggregator"
        ):
            r.error(
                "critical multi-platform acceptance requires "
                "environment.platform_evidence_authority="
                "'external-attestation-aggregator'"
            )

    if risk in {"standard", "critical"} and not _list(environment.get("fingerprint_fields")):
        r.error(f"{risk} contract requires environment.fingerprint_fields")
    discovery_baseline = _dict(contract.get("test_discovery"))
    if not _nonempty(discovery_baseline.get("manifest_digest")):
        r.error("contract.test_discovery.manifest_digest must be non-empty")
    discovery_expected = discovery_baseline.get("expected")
    if not isinstance(discovery_expected, int) or discovery_expected < 0:
        r.error("contract.test_discovery.expected must be a non-negative integer")
    shards = _list(discovery_baseline.get("shards"))
    if not shards:
        r.error("contract.test_discovery.shards must declare the protected shard baseline")
    shard_ids: set[str] = set()
    shard_total = 0
    for index, raw_shard in enumerate(shards):
        shard = _dict(raw_shard)
        shard_id = shard.get("id")
        shard_expected = shard.get("expected")
        if not _nonempty(shard_id) or shard_id in shard_ids:
            r.error(f"contract.test_discovery.shards[{index}].id must be unique and non-empty")
        else:
            shard_ids.add(shard_id)
        if not isinstance(shard_expected, int) or shard_expected < 0:
            r.error(f"contract.test_discovery.shards[{index}].expected must be non-negative")
        else:
            shard_total += shard_expected
    if isinstance(discovery_expected, int) and shard_total != discovery_expected:
        r.error("contract.test_discovery shard totals differ from expected baseline")

    gates = _dict(contract.get("gates"))
    if not _nonempty(gates.get("focused")):
        r.error("contract.gates.focused must be non-empty")
    if risk in {"standard", "critical"} and not _nonempty(gates.get("integration")):
        r.error(f"{risk} contract requires an integration gate")
    if risk == "critical" and not _nonempty(gates.get("release")):
        r.error("critical contract requires a release gate")

    evidence = _dict(contract.get("evidence"))
    if not _nonempty(evidence.get("path")):
        r.error("contract.evidence.path must be non-empty")
    if not _nonempty(evidence.get("retention")):
        r.error("contract.evidence.retention must be non-empty")
    if not _list(evidence.get("invalidated_by")):
        r.error("contract.evidence.invalidated_by must list material invalidators")

    runtime_feedback = _dict(contract.get("runtime_feedback"))
    if not isinstance(runtime_feedback.get("enabled"), bool):
        r.error("contract.runtime_feedback.enabled must be boolean")
    if runtime_feedback.get("enabled") is True:
        if not _list(runtime_feedback.get("signals")):
            r.error("enabled runtime feedback requires signals")
        if not _nonempty(runtime_feedback.get("permanent_corpus_path")):
            r.error("enabled runtime feedback requires permanent_corpus_path")

    source_provenance = contract.get("source_provenance")
    if source_provenance is not None:
        provenance = _dict(source_provenance)
        if not _nonempty(provenance.get("repository")) or not isinstance(
            provenance.get("revision"), str
        ) or not re.fullmatch(r"[0-9a-f]{40,64}", provenance["revision"]) or not isinstance(
            provenance.get("require_clean"), bool
        ):
            r.error(
                "contract.source_provenance requires repository, immutable revision, and boolean require_clean"
            )
    real_upstream = contract.get("real_upstream_workflow")
    if real_upstream is not None and source_provenance is None:
        r.error("real upstream workflow requires source_provenance")
    if real_upstream is not None:
        workflow = _dict(real_upstream)
        repository = workflow.get("repository")
        revision = workflow.get("revision")
        focused_id = workflow.get("focused_command_id")
        broad_id = workflow.get("broad_command_id")
        focused_artifacts = _list(workflow.get("focused_artifacts"))
        broad_artifacts = _list(workflow.get("broad_artifacts"))
        plan = _list(_dict(contract.get("control_plane")).get("execution_plan"))
        plan_by_id = {
            item.get("id"): item
            for item in plan
            if isinstance(item, dict) and _nonempty(item.get("id"))
        }
        protected_assets = {
            item.get("path")
            for item in _list(_dict(contract.get("control_plane")).get("protected_assets"))
            if isinstance(item, dict) and _nonempty(item.get("path"))
        }
        if (
            not _nonempty(repository)
            or not isinstance(revision, str)
            or not re.fullmatch(r"[0-9a-f]{40,64}", revision)
            or not _nonempty(focused_id)
            or not _nonempty(broad_id)
            or not focused_artifacts
            or not broad_artifacts
            or not all(_nonempty(item) for item in focused_artifacts + broad_artifacts)
            or not _nonempty(workflow.get("platform"))
        ):
            r.error(
                "contract.real_upstream_workflow requires repository, immutable revision, focused_command_id, broad_command_id, focused_artifacts, broad_artifacts, and platform"
            )
        elif focused_id == broad_id:
            r.error("real upstream focused_command_id and broad_command_id must be distinct")
        else:
            focused_step = plan_by_id.get(focused_id)
            broad_step = plan_by_id.get(broad_id)
            if focused_step is None or broad_step is None:
                r.error("real upstream workflow command IDs must reference execution plan steps")
            else:
                focused_argv = focused_step.get("argv")
                broad_argv = broad_step.get("argv")
                if focused_argv == broad_argv:
                    r.error("real upstream focused and broad steps must execute distinct argv")
                gates = _dict(contract.get("gates"))
                if focused_step.get("display") != gates.get("focused"):
                    r.error("real upstream focused command display must match contract.gates.focused")
                if broad_step.get("display") != gates.get("broad"):
                    r.error("real upstream broad command display must match contract.gates.broad")
                if not set(focused_artifacts) < set(broad_artifacts):
                    r.error("real upstream broad_artifacts must strictly extend focused_artifacts")
                for artifact in focused_artifacts:
                    if artifact not in _list(focused_argv):
                        r.error("real upstream focused step argv must list each focused_artifact")
                        break
                for artifact in broad_artifacts:
                    if artifact not in _list(broad_argv):
                        r.error("real upstream broad step argv must list each broad_artifact")
                        break
                if not set(focused_artifacts).issubset(set(_list(focused_step.get("artifact_refs")))):
                    r.error("real upstream focused_artifacts must be referenced by focused_command_id")
                if not set(broad_artifacts).issubset(set(_list(broad_step.get("artifact_refs")))):
                    r.error("real upstream broad_artifacts must be referenced by broad_command_id")
                if not set(focused_artifacts + broad_artifacts).issubset(protected_assets):
                    r.error("real upstream artifacts must be protected assets")
        if source_provenance is not None and (
            repository != _dict(source_provenance).get("repository")
            or revision != _dict(source_provenance).get("revision")
        ):
            r.error("real upstream workflow must match contract.source_provenance")
        if workflow.get("platform") != runtime_platform_identity()["platform_id"]:
            r.error("real upstream workflow platform must equal the issuer runtime platform")
    control_plane = _dict(contract.get("control_plane"))
    protected_result_plans: list[tuple[str, dict[str, Any]]] = []
    for plan_name in (
        "discovery", "metric_result", "cutover_result", "release_result",
        "migration_inventory_result", "migration_fencing_result",
        "migration_completion_result",
    ):
        plan_spec = control_plane.get(plan_name)
        if isinstance(plan_spec, dict):
            protected_result_plans.append((f"control_plane.{plan_name}", plan_spec))
    platform_results = control_plane.get("platform_results")
    if platform_results is not None and not isinstance(platform_results, dict):
        r.error("contract.control_plane.platform_results must be an object")
        platform_results = {}
    else:
        platform_results = _dict(platform_results)
    if risk == "critical":
        if not platform_results:
            r.error(
                "critical contract.control_plane.platform_results must declare "
                "one protected result plan per environment.matrix platform"
            )
        missing_platform_plans = sorted(
            platform for platform in declared_matrix if platform not in platform_results
        )
        extra_platform_plans = sorted(
            platform for platform in platform_results if platform not in set(declared_matrix)
        )
        if missing_platform_plans:
            r.error(
                "critical contract.control_plane.platform_results missing plans for: "
                f"{missing_platform_plans}"
            )
        if extra_platform_plans:
            r.error(
                "critical contract.control_plane.platform_results has unknown platforms: "
                f"{extra_platform_plans}"
            )
    for platform, plan_spec in platform_results.items():
        if not _nonempty(platform):
            r.error("contract.control_plane.platform_results keys must be non-empty")
            continue
        if not isinstance(plan_spec, dict):
            r.error(
                f"contract.control_plane.platform_results[{platform}] must be an object"
            )
            continue
        protected_result_plans.append(
            (f"control_plane.platform_results[{platform}]", plan_spec)
        )

    seen_result_command_ids: set[str] = set()
    seen_result_paths: set[str] = set()
    non_stability_role_ids: set[str] = set()
    for plan_label, plan_spec in protected_result_plans:
        command_id = plan_spec.get("command_id")
        result_path = plan_spec.get("result_path")
        producer_path = plan_spec.get("producer_path")
        if not _nonempty(command_id):
            r.error(f"{plan_label}.command_id must be non-empty")
        else:
            if command_id in seen_result_command_ids:
                r.error(
                    f"{plan_label}.command_id must be unique across protected result plans"
                )
            else:
                seen_result_command_ids.add(command_id)
            non_stability_role_ids.add(command_id)
        if not _nonempty(result_path):
            r.error(f"{plan_label}.result_path must be non-empty")
        else:
            if result_path in seen_result_paths:
                r.error(
                    f"{plan_label}.result_path must be unique across protected result plans"
                )
            else:
                seen_result_paths.add(result_path)
        if not _nonempty(producer_path):
            r.error(f"{plan_label}.producer_path must be non-empty")

    if contract.get("migration_profile") == "large_equivalence":
        migration_context = _dict(contract.get("migration_context"))
        protected = {
            asset.get("path")
            for asset in _list(control_plane.get("protected_assets"))
            if isinstance(asset, dict)
        }
        if migration_context.get("role") == "bootstrap":
            inventory_plan = _dict(control_plane.get("migration_inventory_result"))
            if not inventory_plan:
                r.error("large_equivalence bootstrap requires control_plane.migration_inventory_result")
            elif inventory_plan.get("producer_path") not in protected:
                r.error("migration_inventory_result producer must be a protected inventory scanner")
        if migration_context.get("role") == "batch":
            fencing_plan = _dict(control_plane.get("migration_fencing_result"))
            if not fencing_plan:
                r.error("large_equivalence batch requires control_plane.migration_fencing_result")
            elif fencing_plan.get("producer_path") not in protected:
                r.error("migration_fencing_result producer must be a protected runtime authority")
        if migration_context.get("role") == "completion":
            completion_plan = _dict(control_plane.get("migration_completion_result"))
            if not completion_plan:
                r.error("large_equivalence completion requires control_plane.migration_completion_result")
            elif completion_plan.get("producer_path") not in protected:
                r.error("migration_completion_result producer must be a protected reconciliation authority")

    for raw_oracle in _list(contract.get("oracles")):
        oracle = _dict(raw_oracle)
        qualification = _dict(oracle.get("qualification"))
        if qualification.get("status") != "fresh":
            continue
        overlap = sorted(
            set(_list(qualification.get("stability_command_ids"))).intersection(
                non_stability_role_ids
            )
        )
        if overlap:
            r.error(
                f"oracle {oracle.get('id')} stability_command_ids overlap "
                f"non-stability control-plane roles: {overlap}"
            )
    if not _list(contract.get("stop_conditions")):
        r.error("contract.stop_conditions must be non-empty")

    return r


def _validate_migration_evidence(
    migration: dict[str, Any],
    evidence: dict[str, Any],
    contract: dict[str, Any] | None,
    status: Any,
    r: LintResult,
) -> None:
    """Check migration provenance and closure; scheduling remains outside VDD."""
    required = [
        "program_id", "role", "program_generation", "context_fingerprint",
        "source_reference", "source_inventory", "dependency_graph_digest", "gap_inventory_digest",
        "migration_artifact", "source_classification", "impact_index", "candidate_snapshot_digest",
        "parents",
    ]
    _require_fields(migration, required, "evidence.migration", r)
    role = migration.get("role")
    if role not in MIGRATION_ROLES:
        r.error("evidence.migration.role must be bootstrap, batch, completion, cutover, or release")
    for name in [
        "program_generation", "context_fingerprint", "dependency_graph_digest",
        "gap_inventory_digest", "candidate_snapshot_digest",
    ]:
        if not _is_digest(migration.get(name)):
            r.error(f"evidence.migration.{name} must be a canonical sha256 digest")
    candidate = _dict(evidence.get("candidate"))
    if migration.get("candidate_snapshot_digest") != candidate.get("revision"):
        r.error(
            "migration candidate_snapshot_digest differs from evidence candidate revision"
        )
    source_reference = _dict(migration.get("source_reference"))
    _require_fields(
        source_reference,
        ["revision", "inventory_digest", "baseline_digest"],
        "evidence.migration.source_reference",
        r,
    )
    if not _nonempty(source_reference.get("revision")):
        r.error("evidence.migration.source_reference.revision must be non-empty")
    for name in ["inventory_digest", "baseline_digest"]:
        if not _is_digest(source_reference.get(name)):
            r.error(
                "evidence.migration.source_reference."
                f"{name} must be a canonical sha256 digest"
            )
    inventory = _dict(migration.get("source_inventory"))
    _require_fields(
        inventory,
        ["scan_digest", "expected", "discovered", "unit_ids"],
        "evidence.migration.source_inventory",
        r,
    )
    if not _is_digest(inventory.get("scan_digest")):
        r.error("evidence.migration.source_inventory.scan_digest must be a canonical sha256 digest")
    for name in ["expected", "discovered"]:
        if not isinstance(inventory.get(name), int) or inventory.get(name) < 0:
            r.error(f"evidence.migration.source_inventory.{name} must be a non-negative integer")
    if inventory.get("expected") != inventory.get("discovered"):
        r.error("migration source inventory expected/discovered counts differ")
    inventory_unit_ids = _list(inventory.get("unit_ids"))
    if not inventory_unit_ids or any(not _nonempty(unit_id) for unit_id in inventory_unit_ids):
        r.error("migration source inventory unit_ids must be non-empty strings")
    elif len(inventory_unit_ids) != len(set(inventory_unit_ids)):
        r.error("migration source inventory unit_ids must be unique")
    elif inventory.get("expected") != len(inventory_unit_ids):
        r.error("migration source inventory expected count differs from unit_ids")
    migration_artifact = _dict(migration.get("migration_artifact"))
    source_classification = _dict(migration.get("source_classification"))
    impact = _dict(migration.get("impact_index"))
    if migration_artifact.get("kind") not in {"rulebook", "delta_catalog", "behavior_catalog"}:
        r.error(
            "evidence.migration.migration_artifact.kind must be rulebook, delta_catalog, or behavior_catalog"
        )
    if not _nonempty(migration_artifact.get("revision")) or not _is_digest(migration_artifact.get("digest")):
        r.error("evidence.migration.migration_artifact requires revision and canonical digest")
    if (
        not _nonempty(source_classification.get("revision"))
        or not _is_digest(source_classification.get("digest"))
    ):
        r.error(
            "evidence.migration.source_classification requires revision and canonical digest"
        )
    if not _is_digest(impact.get("digest")):
        r.error("evidence.migration.impact_index.digest must be a canonical sha256 digest")
    if impact.get("soundness") != "conservative-transitive":
        r.error("migration impact index must declare conservative-transitive soundness")
    if impact.get("unknown_link_policy") != "invalidate":
        r.error("migration impact index must invalidate unknown links")

    parents = _list(migration.get("parents"))
    parent_ids: set[str] = set()
    parent_stages: set[str] = set()
    for index, raw in enumerate(parents):
        parent = _dict(raw)
        parent_id = parent.get("attestation_id")
        if not _nonempty(parent_id) or parent_id in parent_ids:
            r.error(f"migration parent[{index}] attestation_id must be unique and non-empty")
        else:
            parent_ids.add(parent_id)
        if parent.get("stage") not in {"bootstrap", "batch", "completion", "cutover", "merge"}:
            r.error(f"migration parent[{index}] has an invalid stage")
        else:
            parent_stages.add(parent.get("stage"))
        if parent.get("status") != "accepted":
            r.error(f"migration parent[{index}] must be accepted")
        for name in ["digest", "contract_fingerprint"]:
            if not _is_digest(parent.get(name)):
                r.error(f"migration parent[{index}].{name} must be a canonical sha256 digest")
        if not _nonempty(parent.get("candidate_revision")):
            r.error(f"migration parent[{index}].candidate_revision must be non-empty")

    expected_parent_stages = {
        "bootstrap": set(),
        "batch": {"bootstrap", "batch"},
        "completion": {"bootstrap", "batch"},
        "cutover": {"completion"},
        "release": {"cutover"},
    }.get(role, set())
    if role == "bootstrap" and parents:
        r.error("migration bootstrap evidence must not have parents")
    elif role != "bootstrap":
        required_parent_stages = (
            set(parent_stages)
            if role == "batch"
            else expected_parent_stages
        )
        missing_stages = sorted(required_parent_stages - parent_stages)
        unexpected_stages = sorted(parent_stages - expected_parent_stages)
        if missing_stages:
            r.error(f"migration {role} evidence is missing required parents: {missing_stages}")
        if unexpected_stages:
            r.error(f"migration {role} evidence has invalid parent stages: {unexpected_stages}")
        if role in {"batch", "cutover", "release"} and len(parents) != 1:
            r.error(f"migration {role} evidence requires exactly one direct parent")
        if role == "batch" and len(parents) == 1 and parents[0].get("stage") not in {"bootstrap", "batch"}:
            r.error("migration batch evidence parent must be bootstrap or batch")
        if role == "completion":
            bootstrap_parents = [
                parent for parent in parents if _dict(parent).get("stage") == "bootstrap"
            ]
            batch_parents = [
                parent for parent in parents if _dict(parent).get("stage") == "batch"
            ]
            if len(bootstrap_parents) != 1 or not batch_parents:
                r.error(
                    "migration completion evidence requires exactly one bootstrap "
                    "parent and at least one batch parent"
                )
    if role == "batch":
        batch = _dict(migration.get("batch"))
        _require_fields(batch, ["id", "manifest_digest", "lease_generation", "attempt", "candidate_base_digest", "fencing"], "evidence.migration.batch", r)
        for name in ["manifest_digest", "candidate_base_digest"]:
            if not _is_digest(batch.get(name)):
                r.error(f"evidence.migration.batch.{name} must be a canonical sha256 digest")
        for name in ["lease_generation", "attempt"]:
            if not isinstance(batch.get(name), int) or isinstance(batch.get(name), bool) or batch.get(name) < 1:
                r.error(f"evidence.migration.batch.{name} must be a positive integer")
        fencing = _dict(batch.get("fencing"))
        _require_fields(
            fencing,
            ["authority", "record_digest", "batch_id", "lease_generation", "attempt", "candidate_base_digest", "submitted_snapshot_digest"],
            "evidence.migration.batch.fencing",
            r,
        )
        if not _nonempty(fencing.get("authority")):
            r.error("migration batch fencing requires an authority")
        for name in ["record_digest", "submitted_snapshot_digest"]:
            if not _is_digest(fencing.get(name)):
                r.error(f"migration batch fencing {name} must be a canonical sha256 digest")
        if fencing.get("batch_id") != batch.get("id"):
            r.error("migration batch fencing batch_id differs from batch id")
        for name in ["lease_generation", "attempt", "candidate_base_digest"]:
            if fencing.get(name) != batch.get(name):
                r.error(f"migration batch fencing {name} differs from batch")
        if fencing.get("submitted_snapshot_digest") != candidate.get("revision"):
            r.error(
                "migration batch fencing submitted_snapshot_digest differs from candidate revision"
            )
    if role == "completion":
        completion = _dict(migration.get("completion"))
        _require_fields(completion, ["expected", "accepted", "excluded", "blocked", "unresolved", "unknown", "disposition_digest", "batch_attestations", "impact_index_digest", "unresolved_impact_links", "integration_snapshot_digest", "dispositions"], "evidence.migration.completion", r)
        counts = ["expected", "accepted", "excluded", "blocked", "unresolved", "unknown", "unresolved_impact_links"]
        for name in counts:
            if not isinstance(completion.get(name), int) or completion.get(name) < 0:
                r.error(f"migration completion.{name} must be a non-negative integer")
        if not _is_digest(completion.get("disposition_digest")):
            r.error("migration completion.disposition_digest must be a canonical sha256 digest")
        if completion.get("impact_index_digest") != impact.get("digest"):
            r.error("migration completion impact_index_digest differs from evidence impact index")
        if completion.get("integration_snapshot_digest") != candidate.get("revision"):
            r.error(
                "migration completion integration_snapshot_digest differs from candidate revision"
            )
        dispositions = _list(completion.get("dispositions"))
        if (
            isinstance(completion.get("disposition_digest"), str)
            and completion.get("disposition_digest")
            != canonical_fingerprint(dispositions)
        ):
            r.error("migration completion disposition_digest differs from dispositions")
        disposition_ids: set[str] = set()
        disposition_counts = {
            "accepted": 0,
            "excluded": 0,
            "blocked": 0,
            "unresolved": 0,
            "unknown": 0,
        }
        for index, raw_disposition in enumerate(dispositions):
            disposition = _dict(raw_disposition)
            unit_id = disposition.get("unit_id")
            disposition_status = disposition.get("status")
            if not _nonempty(unit_id) or unit_id in disposition_ids:
                r.error(
                    f"migration completion disposition[{index}].unit_id must be unique and non-empty"
                )
            else:
                disposition_ids.add(unit_id)
            if disposition_status not in disposition_counts:
                r.error(
                    f"migration completion disposition[{index}].status is invalid"
                )
                continue
            disposition_counts[disposition_status] += 1
            if disposition_status == "excluded" and (
                not _nonempty(disposition.get("decision_ref"))
                or not _nonempty(disposition.get("decision_owner"))
            ):
                r.error(
                    "migration completion exclusion requires a named decision reference and owner"
                )
        if len(dispositions) != completion.get("expected"):
            r.error("migration completion dispositions must account for every inventory unit")
        if disposition_ids != set(inventory_unit_ids):
            r.error(
                "migration completion dispositions must exactly match protected inventory unit_ids"
            )
        for name, value in disposition_counts.items():
            if completion.get(name) != value:
                r.error(
                    f"migration completion {name} count differs from protected dispositions"
                )
        if status == "accepted":
            expected = completion.get("expected")
            classified = sum(completion.get(name, 0) for name in ["accepted", "excluded", "blocked", "unresolved", "unknown"])
            if (
                expected != inventory.get("expected")
                or expected != classified
                or completion.get("blocked") != 0
                or completion.get("unresolved") != 0
                or completion.get("unknown") != 0
            ):
                r.error(
                    "accepted migration completion requires protected inventory closure "
                    "with zero blocked, unresolved, and unknown"
                )
            if completion.get("unresolved_impact_links") != 0:
                r.error("accepted migration completion requires zero unresolved impact links")
            batch_refs = _list(completion.get("batch_attestations"))
            if not batch_refs:
                r.error("accepted migration completion requires authenticated batch attestations")
            batch_parent_ids = {
                _dict(parent).get("attestation_id")
                for parent in parents
                if _dict(parent).get("stage") == "batch"
            }
            batch_parent_refs = {
                (
                    _dict(parent).get("attestation_id"),
                    _dict(parent).get("digest"),
                )
                for parent in parents
                if _dict(parent).get("stage") == "batch"
            }
            completion_batch_refs = {
                (
                    _dict(item).get("attestation_id"),
                    _dict(item).get("digest"),
                )
                for item in batch_refs
            }
            if completion_batch_refs != batch_parent_refs:
                r.error(
                    "migration completion batch attestations must exactly match "
                    "authenticated batch parents"
                )

    if contract is None:
        return
    context = _dict(contract.get("migration_context"))
    if not context:
        return
    mapping = {
        "program_id": "program_id",
        "role": "role",
        "program_generation": "program_generation",
        "dependency_graph_digest": "dependency_graph_digest",
        "gap_inventory_digest": "gap_inventory_digest",
        "candidate_snapshot_digest": "candidate_snapshot_digest",
    }
    for evidence_key, contract_key in mapping.items():
        if migration.get(evidence_key) != context.get(contract_key):
            r.error(f"migration {evidence_key} differs from linked contract")
    source = _dict(context.get("source_reference"))
    if source_reference != source:
        r.error("migration source_reference differs from linked contract")
    if inventory.get("scan_digest") != source.get("inventory_digest"):
        r.error("migration source inventory scan_digest differs from linked contract inventory")
    contract_migration_artifact = _dict(context.get("migration_artifact"))
    if migration_artifact != contract_migration_artifact:
        r.error("migration artifact differs from linked contract")
    contract_source_classification = _dict(context.get("source_classification"))
    if source_classification != contract_source_classification:
        r.error("migration source classification differs from linked contract")
    contract_impact = _dict(context.get("impact_index"))
    if impact != contract_impact:
        r.error("migration impact index differs from linked contract")
    expected_context_fingerprint = canonical_fingerprint(context)
    if migration.get("context_fingerprint") != expected_context_fingerprint:
        r.error("migration context_fingerprint differs from linked contract context")
    if role == "batch" and _dict(migration.get("batch")) != _dict(context.get("batch")):
        r.error("migration batch fencing fields differ from linked contract")


def validate_evidence(evidence: dict[str, Any], contract: dict[str, Any] | None = None) -> LintResult:
    r = LintResult()
    _require_fields(
        evidence,
        [
            "schema_version", "attestation_id", "objective_id", "mode", "risk_profile",
            "stage", "status", "candidate", "contract", "oracles", "fixtures",
            "environment", "test_discovery", "commands", "claim_results",
            "defeater_results", "forbidden_scope_diff", "residual_risks",
            "invalidation_events", "issued_by", "merge", "release", "runtime_feedback",
            "retained_at", "issued_at",
        ],
        "evidence",
        r,
    )
    if evidence.get("schema_version") != "vdd-0.4":
        r.error("evidence.schema_version must be 'vdd-0.4'")
    mode = evidence.get("mode")
    risk = evidence.get("risk_profile")
    stage = evidence.get("stage")
    status = evidence.get("status")
    if mode not in MODES:
        r.error(f"evidence.mode must be one of {sorted(MODES)}")
    if risk not in RISKS:
        r.error(f"evidence.risk_profile must be one of {sorted(RISKS)}")
    if stage not in {"characterization", "merge", "release", *MIGRATION_STAGES}:
        r.error("evidence.stage must be characterization, bootstrap, batch, completion, cutover, merge, or release")
    if status not in {"accepted", "blocked", "invalidated"}:
        r.error("evidence.status must be accepted, blocked, or invalidated")
    migration = _dict(evidence.get("migration"))
    migration_profile = _dict(contract).get("migration_profile", "none") if contract else "none"
    if mode == "characterization" and stage != "characterization":
        r.error(f"{mode} mode and {stage} stage is incompatible")
    elif mode in {"construction", "equivalence", "improvement"} and stage == "characterization":
        r.error(f"{mode} mode and {stage} stage is incompatible")
    if migration:
        if migration_profile != "large_equivalence":
            r.error("migration evidence requires linked contract migration_profile=large_equivalence")
        if mode != "equivalence" or stage not in MIGRATION_STAGES:
            r.error("migration evidence requires equivalence mode and a migration stage")
        if migration.get("role") != stage:
            r.error("migration evidence role must match its stage")
    elif migration_profile == "large_equivalence":
        r.error("large_equivalence evidence requires migration context")
    if status == "accepted" and contract is None:
        r.error("accepted evidence requires a linked contract")

    candidate = _dict(evidence.get("candidate"))
    if contract is not None and _dict(contract).get("source_provenance") is not None:
        provenance = _dict(_dict(evidence.get("control_plane")).get("source_provenance"))
        expected = _dict(_dict(contract).get("source_provenance"))
        artifacts = _list(provenance.get("candidate_artifacts"))
        if (
            provenance.get("repository") != expected.get("repository")
            or provenance.get("revision") != expected.get("revision")
            or not isinstance(provenance.get("clean"), bool)
            or not artifacts
        ):
            r.error("evidence source provenance differs from contract or lacks candidate artifacts")
        elif expected.get("require_clean") is True and provenance.get("clean") is not True:
            r.error("evidence source provenance must be clean")
        expected_candidate_snapshot = {
            item.get("path"): item.get("fingerprint")
            for item in _list(
                _dict(evidence.get("control_plane")).get(
                    "candidate_snapshot_before"
                )
            )
            if isinstance(item, dict)
            and isinstance(item.get("path"), str)
            and isinstance(item.get("fingerprint"), str)
            and item["path"]
            and not item["path"].endswith("/")
        }
        expected_candidate_paths = set(expected_candidate_snapshot)
        if not expected_candidate_paths:
            expected_candidate_paths = {
                path
                for path in _list(
                    _dict(contract).get("control_plane").get("candidate_artifacts")
                )
                if isinstance(path, str) and path and not path.endswith("/")
            }
            expected_candidate_snapshot = {}
        observed_candidate_paths: set[str] = set()
        observed_candidate_fingerprints: dict[str, str] = {}
        for index, artifact in enumerate(artifacts):
            if (
                not isinstance(artifact, dict)
                or not _nonempty(artifact.get("path"))
                or not _is_digest(artifact.get("fingerprint"))
                or not _is_digest(artifact.get("source_fingerprint"))
                or artifact.get("git_type") not in {"file", "symlink"}
                or artifact.get("git_mode") not in {"100644", "100755", "120000"}
                or not isinstance(artifact.get("git_object"), str)
                or not re.fullmatch(r"[0-9a-f]{40,64}", artifact["git_object"])
                or (
                    artifact.get("git_type") == "file"
                    and artifact.get("git_mode") not in {"100644", "100755"}
                )
                or (
                    artifact.get("git_type") == "symlink"
                    and artifact.get("git_mode") != "120000"
                )
            ):
                r.error(
                    "evidence source provenance candidate artifact must bind path, "
                    f"candidate/source fingerprints, compatible git type/mode/object: {index}"
                )
                continue
            path = artifact["path"]
            if Path(path).is_absolute() or any(part in {"", ".", ".."} for part in Path(path).parts):
                r.error(
                    "evidence source provenance candidate artifact path must be canonical: "
                    f"{path!r}"
                )
                continue
            if path in observed_candidate_paths:
                r.error(f"evidence source provenance has duplicate candidate artifact: {path}")
                continue
            observed_candidate_paths.add(path)
            observed_candidate_fingerprints[path] = artifact["fingerprint"]
        if observed_candidate_paths != expected_candidate_paths:
            r.error("evidence source provenance candidate artifact paths differ from contract")
        elif expected_candidate_snapshot and (
            observed_candidate_fingerprints != expected_candidate_snapshot
        ):
            r.error(
                "evidence source provenance candidate artifact fingerprints differ "
                "from candidate snapshot"
            )

        real_upstream = _dict(_dict(contract).get("real_upstream_workflow"))
        upstream_artifacts = _list(provenance.get("real_upstream_artifacts"))
        if real_upstream:
            expected_upstream_paths = {
                path
                for path in [
                    *_list(real_upstream.get("focused_artifacts")),
                    *_list(real_upstream.get("broad_artifacts")),
                ]
                if isinstance(path, str) and path
            }
            protected_fingerprints = {
                item.get("path"): item.get("fingerprint")
                for item in _list(
                    _dict(contract).get("control_plane").get("protected_assets")
                )
                if isinstance(item, dict)
                and isinstance(item.get("path"), str)
                and isinstance(item.get("fingerprint"), str)
            }
            observed_upstream_paths: set[str] = set()
            observed_upstream_fingerprints: dict[str, str] = {}
            for index, artifact in enumerate(upstream_artifacts):
                if (
                    not isinstance(artifact, dict)
                    or not _nonempty(artifact.get("path"))
                    or not _is_digest(artifact.get("fingerprint"))
                    or artifact.get("git_type") not in {"file", "symlink"}
                    or artifact.get("git_mode") not in {"100644", "100755", "120000"}
                    or not isinstance(artifact.get("git_object"), str)
                    or not re.fullmatch(r"[0-9a-f]{40,64}", artifact["git_object"])
                    or (
                        artifact.get("git_type") == "file"
                        and artifact.get("git_mode") not in {"100644", "100755"}
                    )
                    or (
                        artifact.get("git_type") == "symlink"
                        and artifact.get("git_mode") != "120000"
                    )
                ):
                    r.error(
                        "evidence real upstream artifact bindings must include canonical "
                        f"path/fingerprint/compatible git type/mode/object: {index}"
                    )
                    continue
                path = artifact["path"]
                if Path(path).is_absolute() or any(part in {"", ".", ".."} for part in Path(path).parts):
                    r.error(
                        "evidence real upstream artifact bindings contain a non-canonical path: "
                        f"{path!r}"
                    )
                    continue
                if path in observed_upstream_paths:
                    r.error(f"evidence real upstream artifact bindings duplicate path: {path}")
                    continue
                observed_upstream_paths.add(path)
                observed_upstream_fingerprints[path] = artifact["fingerprint"]
            if observed_upstream_paths != expected_upstream_paths:
                r.error("evidence real upstream artifact bindings differ from contract")
            elif any(
                observed_upstream_fingerprints[path] != protected_fingerprints.get(path)
                for path in expected_upstream_paths
            ):
                r.error(
                    "evidence real upstream artifact fingerprints differ from protected assets"
                )
        elif upstream_artifacts:
            r.error("evidence real upstream artifact bindings require real_upstream_workflow")
    if not _nonempty(candidate.get("revision")):
        r.error("evidence.candidate.revision must be non-empty")
    if not _list(candidate.get("artifact_digests")):
        r.error("evidence.candidate.artifact_digests must be non-empty")
    if status == "accepted" and risk in {"standard", "critical"} and candidate.get("dirty") is not False:
        r.error(f"accepted {risk} evidence requires candidate.dirty == false")

    contract_ref = _dict(evidence.get("contract"))
    if not _nonempty(contract_ref.get("revision")) or not _nonempty(contract_ref.get("fingerprint")):
        r.error("evidence.contract requires revision and fingerprint")

    oracle_evidence = _unique_ids(_list(evidence.get("oracles")), "evidence.oracles", r)
    for oid, oracle in oracle_evidence.items():
        if not _nonempty(oracle.get("revision")) or not _nonempty(oracle.get("fingerprint")):
            r.error(f"evidence oracle {oid} requires revision and fingerprint")
        if status == "accepted" and oracle.get("qualified") is not True:
            r.error(f"accepted evidence relies on unqualified oracle {oid}")
        trials = oracle.get("no_change_trials")
        if not isinstance(trials, int) or trials < 0:
            r.error(f"evidence oracle {oid}.no_change_trials must be non-negative")
        flake = oracle.get("flake_rate")
        if not isinstance(flake, (int, float)) or not 0 <= float(flake) <= 1:
            r.error(f"evidence oracle {oid}.flake_rate must be between 0 and 1")

    environment = _dict(evidence.get("environment"))
    if not _nonempty(environment.get("digest")):
        r.error("evidence.environment.digest must be non-empty")

    discovery = _dict(evidence.get("test_discovery"))
    if not _nonempty(discovery.get("manifest_digest")):
        r.error("evidence.test_discovery.manifest_digest must be non-empty")
    expected = discovery.get("expected")
    discovered = discovery.get("discovered")
    executed = discovery.get("executed")
    skipped = _list(discovery.get("skipped"))
    approved_skips = set(_list(discovery.get("approved_skips")))
    if len(skipped) != len(set(skipped)):
        r.error("test discovery skipped contains duplicate skip ids")
    for field_name, value in [
        ("expected", expected),
        ("discovered", discovered),
        ("executed", executed),
    ]:
        if not isinstance(value, int) or value < 0:
            r.error(f"test discovery {field_name} must be a non-negative integer")
    if isinstance(expected, int) and isinstance(discovered, int) and expected != discovered:
        r.error(f"test discovery mismatch: expected {expected}, discovered {discovered}")
    if isinstance(discovered, int) and isinstance(executed, int) and discovered != executed + len(skipped):
        r.error(
            f"test execution mismatch: discovered {discovered}, executed {executed}, "
            f"skipped {len(skipped)}"
        )
    unapproved_skips = [item for item in skipped if item not in approved_skips]
    if status == "accepted" and unapproved_skips:
        r.error(f"accepted evidence contains unapproved skips: {unapproved_skips}")

    discovery_shards = _unique_ids(
        _list(discovery.get("shards")),
        "evidence.test_discovery.shards",
        r,
    )
    shard_discovered_total = 0
    shard_skipped: list[Any] = []
    for shard_id, shard in discovery_shards.items():
        shard_discovered = shard.get("discovered")
        shard_executed = shard.get("executed")
        shard_skips = _list(shard.get("skipped"))
        if len(shard_skips) != len(set(shard_skips)):
            r.error(f"discovery shard {shard_id}.skipped contains duplicate skip ids")
        if not isinstance(shard_discovered, int) or shard_discovered < 0:
            r.error(f"discovery shard {shard_id}.discovered must be non-negative")
            continue
        if not isinstance(shard_executed, int) or shard_executed < 0:
            r.error(f"discovery shard {shard_id}.executed must be non-negative")
            continue
        if shard_discovered != shard_executed + len(shard_skips):
            r.error(f"discovery shard {shard_id} execution count is incomplete")
        shard_discovered_total += shard_discovered
        shard_skipped.extend(shard_skips)
    if isinstance(discovered, int) and shard_discovered_total != discovered:
        r.error("test discovery shard totals differ from discovered count")
    if sorted(shard_skipped) != sorted(skipped):
        r.error("test discovery shard skips differ from top-level skipped tests")

    allowed_flaky_stability_ids = {
        command_id
        for oracle in _list(_dict(contract).get("oracles"))
        if isinstance(oracle, dict)
        and _dict(oracle.get("qualification")).get("status") == "fresh"
        for command_id in _list(
            _dict(oracle.get("qualification")).get("stability_command_ids")
        )
    }
    linked_control_plane = _dict(_dict(contract).get("control_plane"))
    non_stability_role_ids = {
        command_id
        for command_id in [
            _dict(linked_control_plane.get("discovery")).get("command_id"),
            _dict(linked_control_plane.get("metric_result")).get("command_id"),
            _dict(linked_control_plane.get("cutover_result")).get("command_id"),
            _dict(linked_control_plane.get("release_result")).get("command_id"),
            _dict(linked_control_plane.get("migration_inventory_result")).get("command_id"),
            _dict(linked_control_plane.get("migration_fencing_result")).get("command_id"),
            _dict(linked_control_plane.get("migration_completion_result")).get("command_id"),
            *[
                _dict(plan_spec).get("command_id")
                for plan_spec in _dict(
                    linked_control_plane.get("platform_results")
                ).values()
            ],
        ]
        if _nonempty(command_id)
    }
    overlapping_stability_roles = sorted(
        allowed_flaky_stability_ids.intersection(non_stability_role_ids)
    )
    if overlapping_stability_roles:
        r.error(
            "stability_command_ids overlap non-stability control-plane roles: "
            f"{overlapping_stability_roles}"
        )
        allowed_flaky_stability_ids.difference_update(non_stability_role_ids)
    commands = _list(evidence.get("commands"))
    if not commands:
        r.error("evidence.commands must contain exact execution records")
    output_directory = _dict(evidence.get("control_plane")).get("output_directory")
    has_output_capture = any(
        isinstance(_dict(raw_command).get("output_capture"), dict)
        for raw_command in commands
    )
    if output_directory is not None:
        if not _nonempty(output_directory) or not Path(output_directory).is_absolute():
            r.error("evidence.control_plane.output_directory must be an absolute path or null")
        for index, raw_command in enumerate(commands):
            command = _dict(raw_command)
            if not _dict(command.get("output_capture")):
                r.error(
                    f"evidence command {index} must retain output_capture when output_directory is declared"
                )
    elif has_output_capture:
        r.error("evidence command output_capture requires control_plane.output_directory")
    has_expected_reject = False
    has_pass = False
    command_ids: set[str] = set()
    command_records: dict[str, dict[str, Any]] = {}
    retained_output_paths: set[str] = set()
    for index, raw in enumerate(commands):
        command = _dict(raw)
        command_id = command.get("id")
        if not _nonempty(command_id):
            r.error(f"commands[{index}].id is required")
        elif command_id in command_ids:
            r.error(f"duplicate command id: {command_id}")
        else:
            command_ids.add(command_id)
            command_records[command_id] = command
        if not _nonempty(command.get("command")):
            r.error(f"commands[{index}].command is required")
        output_capture = command.get("output_capture")
        if output_capture is not None:
            if not isinstance(output_capture, dict):
                r.error(f"commands[{index}].output_capture must be an object")
            else:
                for output_name in ("stdout", "stderr", "isolation"):
                    artifact = output_capture.get(output_name)
                    if not isinstance(artifact, dict):
                        r.error(
                            f"commands[{index}].output_capture.{output_name} must be an object"
                        )
                        continue
                    path = artifact.get("path")
                    if not _nonempty(path) or not _is_digest(artifact.get("fingerprint")):
                        r.error(
                            f"commands[{index}].output_capture.{output_name} requires path and fingerprint"
                        )
                    elif (
                        Path(path).is_absolute()
                        or any(part in {"", ".", ".."} for part in Path(path).parts)
                    ):
                        r.error(
                            f"commands[{index}].output_capture.{output_name}.path must be canonical"
                        )
                    elif path in retained_output_paths:
                        r.error(f"duplicate retained output path: {path}")
                    else:
                        retained_output_paths.add(path)
                    if output_name != "isolation":
                        if not _is_digest(artifact.get("digest")):
                            r.error(
                                f"commands[{index}].output_capture.{output_name}.digest must be a canonical sha256 digest"
                            )
                        byte_length = artifact.get("byte_length")
                        if (
                            not isinstance(byte_length, int)
                            or isinstance(byte_length, bool)
                            or byte_length < 0
                        ):
                            r.error(
                                f"commands[{index}].output_capture.{output_name}.byte_length must be non-negative"
                            )
                        elif byte_length > 8 * 1024 * 1024:
                            r.error(
                                f"commands[{index}].output_capture.{output_name}.byte_length must not exceed 8388608"
                            )
                isolation = output_capture.get("isolation")
                if isinstance(isolation, dict) and (
                    not _nonempty(isolation.get("provider"))
                    or not _nonempty(isolation.get("policy_format"))
                    or not _is_digest(isolation.get("executable_fingerprint"))
                ):
                    r.error(
                        f"commands[{index}].output_capture.isolation requires provider, policy_format, and executable_fingerprint"
                    )
        result_value = command.get("result")
        if result_value not in COMMAND_RESULTS:
            r.error(f"commands[{index}].result must be one of {sorted(COMMAND_RESULTS)}")
        exit_code = command.get("exit_code")
        if not isinstance(exit_code, int):
            r.error(f"commands[{index}].exit_code must be an integer")
        elif result_value == "pass" and exit_code != 0:
            r.error(f"command {command_id} pass requires exit_code 0")
        elif result_value == "expected_reject" and exit_code == 0:
            r.error(f"command {command_id} expected_reject requires a non-zero exit_code")
        has_expected_reject |= result_value == "expected_reject"
        has_pass |= result_value == "pass"
        if (
            status == "accepted"
            and (
                result_value == "blocked"
                or (
                    result_value == "fail"
                    and command_id not in allowed_flaky_stability_ids
                )
            )
        ):
            r.error(
                f"accepted evidence contains required command {command_id} "
                f"with result {result_value}"
            )
    if status == "accepted" and not has_pass:
        r.error("accepted evidence requires at least one passing execution")
    real_upstream = _dict(_dict(contract).get("real_upstream_workflow"))
    if real_upstream:
        for field_name, label in (
            ("focused_command_id", "focused"),
            ("broad_command_id", "broad"),
        ):
            command_id = real_upstream.get(field_name)
            command = command_records.get(command_id)
            if command is None or command.get("result") != "pass":
                r.error(f"real upstream {label} command must be an executed passing step")
                continue
            artifacts = _list(real_upstream.get(f"{label}_artifacts"))
            if not set(artifacts).issubset(set(_list(command.get("artifact_refs")))):
                r.error(f"real upstream {label} command lacks its declared upstream artifacts")
    if status == "accepted" and mode in {"characterization", "construction", "equivalence"} and not has_expected_reject:
        r.error(f"accepted {mode} evidence requires an expected rejection proving RED/discrimination")
    mode_evidence = _dict(evidence.get("mode_evidence"))
    if not mode_evidence:
        r.error(f"{mode} mode_evidence is required")

    def require_command_ids(
        refs: Any,
        label: str,
        expected_result: str,
        *,
        single: bool = False,
    ) -> None:
        values = [refs] if single and _nonempty(refs) else _list(refs)
        if not values:
            r.error(f"{label} must reference at least one command")
            return
        for command_id in values:
            command = command_records.get(command_id)
            if command is None:
                r.error(f"{label} references unknown command {command_id}")
            elif command.get("result") != expected_result:
                r.error(f"{label} command {command_id} must be {expected_result}")

    if mode == "characterization" and mode_evidence:
        require_command_ids(
            mode_evidence.get("known_good_commands"),
            "characterization known-good evidence",
            "pass",
        )
        require_command_ids(
            mode_evidence.get("known_bad_commands"),
            "characterization known-bad evidence",
            "expected_reject",
        )
        trials = mode_evidence.get("stability_trials")
        if not isinstance(trials, int) or trials < 1:
            r.error("characterization mode_evidence.stability_trials must be positive")
        if not isinstance(mode_evidence.get("unknowns"), list):
            r.error("characterization mode_evidence.unknowns must be an array")
        if not _list(mode_evidence.get("reusable_artifacts")):
            r.error("characterization mode_evidence.reusable_artifacts must be non-empty")
    elif mode == "construction" and mode_evidence:
        require_command_ids(
            mode_evidence.get("semantic_red_command"),
            "construction semantic RED evidence",
            "expected_reject",
            single=True,
        )
        require_command_ids(
            mode_evidence.get("focused_green_commands"),
            "construction focused GREEN evidence",
            "pass",
        )
        require_command_ids(
            mode_evidence.get("boundary_commands"),
            "construction boundary evidence",
            "pass",
        )
    elif mode == "equivalence":
        if migration and stage == "bootstrap":
            pass
        else:
            require_command_ids(
                mode_evidence.get("reference_green_command"),
                "equivalence reference GREEN evidence",
                "pass",
                single=True,
            )
            require_command_ids(
                mode_evidence.get("deviation_rejection_commands"),
                "equivalence deviation rejection evidence",
                "expected_reject",
            )
            require_command_ids(
                mode_evidence.get("parity_commands"),
                "equivalence parity evidence",
                "pass",
            )
            if not _nonempty(mode_evidence.get("identical_input_fingerprint")):
                r.error("equivalence mode_evidence.identical_input_fingerprint must be non-empty")
            classification = _dict(mode_evidence.get("behavior_classification"))
            if not _list(classification.get("accepted")):
                r.error("equivalence behavior_classification.accepted must be non-empty")
            if not isinstance(classification.get("corrected"), list):
                r.error("equivalence behavior_classification.corrected must be an array")
            unknown_behavior = _list(classification.get("unknown"))
            if status == "accepted" and unknown_behavior:
                r.error("accepted Equivalence evidence cannot contain unknown behavior")
        if not (migration and stage in {"bootstrap", "batch", "completion"}):
            cutover_evidence = _dict(mode_evidence.get("cutover"))
            for field_name in [
                "callers_total",
                "callers_migrated",
                "unresolved",
                "unknown",
                "legacy_runtime_dependencies",
            ]:
                value = cutover_evidence.get(field_name)
                if not isinstance(value, int) or value < 0:
                    r.error(f"equivalence cutover.{field_name} must be non-negative")
            if (
                isinstance(cutover_evidence.get("callers_total"), int)
                and cutover_evidence.get("callers_migrated")
                != cutover_evidence.get("callers_total")
            ):
                r.error("equivalence cutover caller migration is incomplete")
            if status == "accepted" and (
                cutover_evidence.get("unresolved") != 0
                or cutover_evidence.get("unknown") != 0
                or cutover_evidence.get("legacy_runtime_dependencies") != 0
            ):
                r.error("accepted Equivalence evidence requires zero cutover residuals")
            if not _list(cutover_evidence.get("removed_production_paths")):
                r.error("equivalence cutover.removed_production_paths must be non-empty")
            if not _nonempty(cutover_evidence.get("result_command")):
                r.error("equivalence cutover result_command is required")
            else:
                require_command_ids(
                    cutover_evidence.get("result_command"),
                    "equivalence cutover result_command",
                    "pass",
                    single=True,
                )
            if not isinstance(cutover_evidence.get("cutover_complete"), bool):
                r.error("equivalence cutover.cutover_complete must be boolean")
            elif status == "accepted" and cutover_evidence.get("cutover_complete") is not True:
                r.error("accepted Equivalence cutover.cutover_complete must be true")
            if not isinstance(cutover_evidence.get("rollback_exercised"), bool):
                r.error("equivalence cutover.rollback_exercised must be boolean")
    elif mode == "improvement" and mode_evidence:
        require_command_ids(
            mode_evidence.get("semantic_green_commands"),
            "improvement semantic GREEN evidence",
            "pass",
        )
        require_command_ids(
            mode_evidence.get("hard_constraint_commands"),
            "improvement hard-constraint evidence",
            "pass",
        )
        if contract is not None:
            contracted_hard = [
                item
                for item in _list(
                    _dict(contract.get("baseline")).get("hard_constraint_commands")
                )
                if _nonempty(item)
            ]
            observed_hard = [
                item
                for item in _list(mode_evidence.get("hard_constraint_commands"))
                if _nonempty(item)
            ]
            if contracted_hard and sorted(observed_hard) != sorted(contracted_hard):
                missing = sorted(set(contracted_hard) - set(observed_hard))
                extra = sorted(set(observed_hard) - set(contracted_hard))
                detail = []
                if missing:
                    detail.append(f"missing {missing}")
                if extra:
                    detail.append(f"unexpected {extra}")
                r.error(
                    "improvement hard-constraint commands must match contract "
                    f"baseline.hard_constraint_commands ({'; '.join(detail)})"
                )
        require_command_ids(
            mode_evidence.get("fast_path_command"),
            "improvement fast-path evidence",
            "pass",
            single=True,
        )
        require_command_ids(
            mode_evidence.get("metric_command"),
            "improvement metric evidence",
            "pass",
            single=True,
        )
        metric_result = _dict(mode_evidence.get("metric_result"))
        if not _nonempty(metric_result.get("name")):
            r.error("improvement metric_result.name must be non-empty")
        if metric_result.get("direction") not in {"higher", "lower", "within_range"}:
            r.error("improvement metric_result.direction is invalid")
        for field_name in ["baseline_samples", "candidate_samples"]:
            samples = _list(metric_result.get(field_name))
            if len(samples) < 3 or any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in samples
            ):
                r.error(f"improvement metric_result.{field_name} requires finite numeric samples")
        for field_name in ["noise_band", "minimum_meaningful_change"]:
            if not isinstance(metric_result.get(field_name), (int, float)):
                r.error(f"improvement metric_result.{field_name} must be numeric")
        result_value = metric_result.get("result")
        if result_value not in {"improved", "statistical_inconclusive", "regressed"}:
            r.error("improvement metric_result.result is invalid")
        if status == "accepted" and result_value != "improved":
            r.error("accepted Improvement evidence requires an improved metric result")
        if contract is not None:
            contracted_metric = _dict(_dict(contract.get("baseline")).get("metric"))
            if metric_result.get("name") != contracted_metric.get("name"):
                r.error("improvement metric name differs from contract baseline")
            if metric_result.get("direction") != contracted_metric.get("direction"):
                r.error("improvement metric direction differs from contract baseline")
            required_runs = contracted_metric.get("runs")
            if isinstance(required_runs, int) and required_runs > 0:
                for field_name in ["baseline_samples", "candidate_samples"]:
                    if len(_list(metric_result.get(field_name))) < required_runs:
                        r.error(
                            f"improvement metric_result.{field_name} requires at least "
                            f"{required_runs} samples"
                        )
            observed_noise = _numeric_policy(metric_result.get("noise_band"))
            required_noise = _numeric_policy(contracted_metric.get("noise_band"))
            if observed_noise != required_noise:
                r.error("improvement metric noise band differs from contract baseline")
            observed_minimum = _numeric_policy(
                metric_result.get("minimum_meaningful_change")
            )
            required_minimum = _numeric_policy(
                contracted_metric.get("minimum_improvement")
            )
            if observed_minimum != required_minimum:
                r.error("improvement metric minimum improvement differs from contract baseline")

        derived_result = _derived_improvement_result(
            _list(metric_result.get("baseline_samples")),
            _list(metric_result.get("candidate_samples")),
            metric_result.get("direction"),
            _numeric_policy(metric_result.get("noise_band")),
            _numeric_policy(metric_result.get("minimum_meaningful_change")),
        )
        if derived_result is None:
            r.error("improvement metric result cannot be derived from the declared samples")
        elif result_value != derived_result:
            r.error(
                f"improvement metric result {result_value!r} contradicts derived "
                f"result {derived_result!r}"
            )

    if migration:
        _validate_migration_evidence(migration, evidence, contract, status, r)

    claim_results = _list(evidence.get("claim_results"))
    claim_status: dict[str, str] = {}
    for index, raw in enumerate(claim_results):
        item = _dict(raw)
        cid = item.get("claim_id")
        if not _nonempty(cid):
            r.error(f"claim_results[{index}].claim_id is required")
            continue
        if cid in claim_status:
            r.error(f"duplicate claim result for {cid}")
        state = item.get("status")
        if state not in {"confirmed", "refuted", "unknown"}:
            r.error(f"claim {cid} status must be confirmed, refuted, or unknown")
        claim_status[cid] = state
        evidence_refs = _list(item.get("evidence_refs"))
        if state in {"confirmed", "refuted"} and not evidence_refs:
            r.error(f"claim {cid} {state} requires command evidence_refs")
        unknown_refs = sorted(ref for ref in evidence_refs if ref not in command_ids)
        if unknown_refs:
            r.error(f"claim {cid} references unknown command evidence: {unknown_refs}")
        referenced_commands = [
            command_records[ref] for ref in evidence_refs if ref in command_records
        ]
        for command in referenced_commands:
            if cid not in _list(command.get("claim_ids")):
                r.error(
                    f"command {command.get('id')} does not declare claim {cid} coverage"
                )
        if state == "confirmed" and referenced_commands and not any(
            command.get("result") == "pass" for command in referenced_commands
        ):
            r.error(f"confirmed claim {cid} requires passing command evidence")
        if status == "accepted" and state != "confirmed":
            r.error(f"accepted evidence cannot leave required claim {cid} as {state}")

    defeater_results = _list(evidence.get("defeater_results"))
    defeater_status: dict[str, str] = {}
    for index, raw in enumerate(defeater_results):
        item = _dict(raw)
        did = item.get("defeater_id")
        if not _nonempty(did):
            r.error(f"defeater_results[{index}].defeater_id is required")
            continue
        if did in defeater_status:
            r.error(f"duplicate defeater result for {did}")
        state = item.get("status")
        if state not in {"eliminated", "survived", "accepted_residual", "unknown"}:
            r.error(f"defeater {did} status is invalid")
        defeater_status[did] = state
        evidence_refs = _list(item.get("evidence_refs"))
        if state in {"eliminated", "survived"} and not evidence_refs:
            r.error(f"defeater {did} {state} requires command evidence_refs")
        unknown_refs = sorted(ref for ref in evidence_refs if ref not in command_ids)
        if unknown_refs:
            r.error(f"defeater {did} references unknown command evidence: {unknown_refs}")
        referenced_commands = [
            command_records[ref] for ref in evidence_refs if ref in command_records
        ]
        for command in referenced_commands:
            if did not in _list(command.get("defeater_ids")):
                r.error(
                    f"command {command.get('id')} does not declare defeater {did} coverage"
                )
        if state == "eliminated" and referenced_commands:
            referenced_results = {
                command.get("result") for command in referenced_commands
            }
            if not {"expected_reject", "pass"}.issubset(referenced_results):
                r.error(
                    f"eliminated defeater {did} requires rejection and candidate-pass evidence"
                )
        if status == "accepted" and state in {"survived", "unknown"}:
            r.error(f"accepted evidence cannot leave defeater {did} as {state}")
    residual_records: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(_list(evidence.get("residual_risks"))):
        record = _dict(raw)
        did = record.get("defeater_id")
        if not _nonempty(did):
            r.error(f"residual_risks[{index}].defeater_id is required")
            continue
        if did in residual_records:
            r.error(f"duplicate residual risk record for {did}")
        residual_records[did] = record

    if status == "accepted" and _list(evidence.get("forbidden_scope_diff")):
        r.error("accepted evidence must have an empty forbidden_scope_diff")
    if status == "accepted" and _list(evidence.get("invalidation_events")):
        r.error("accepted evidence cannot contain material invalidation_events")
    if status == "invalidated" and not _list(evidence.get("invalidation_events")):
        r.error("invalidated evidence requires at least one invalidation event")

    issuer = _dict(evidence.get("issued_by"))
    if not _nonempty(issuer.get("identity")) or not _nonempty(issuer.get("role")):
        r.error("evidence.issued_by requires identity and role")
    if status == "accepted" and issuer.get("independent_from_candidate") is not True:
        r.error("accepted evidence requires an independent issuer outside candidate write authority")

    merge = _dict(evidence.get("merge"))
    release = _dict(evidence.get("release"))
    acceptance_merge_stages = {"merge", "release"}
    if migration:
        acceptance_merge_stages.update({"cutover"})
    if status == "accepted" and stage in acceptance_merge_stages:
        if merge.get("integration_passed") is not True:
            r.error(f"accepted {stage} evidence requires merge.integration_passed")
        if mode == "equivalence" and stage in {"cutover", "merge", "release"} and merge.get("cutover_complete") is not True:
            r.error("accepted Equivalence cutover/merge/release evidence requires cutover_complete")
        if risk == "critical" and stage in {"cutover", "merge", "release"} and merge.get("rollback_exercised") is not True:
            r.error("accepted Critical cutover/merge/release evidence requires rollback_exercised")
    if status == "accepted" and stage == "release":
        if not _nonempty(release.get("canary_or_shadow")):
            r.error("release attestation requires canary_or_shadow evidence")
        if release.get("thresholds_passed") is not True:
            r.error("release attestation requires thresholds_passed")
        if not _nonempty(release.get("rollback_trigger")):
            r.error("release attestation requires rollback_trigger")
        if not _nonempty(release.get("release_owner")):
            r.error("release attestation requires release_owner")
        if merge.get("rollback_exercised") is not True:
            r.error("release attestation requires rollback_exercised")
        if not _nonempty(release.get("result_command")):
            r.error("release result_command is required for authenticated release facts")
        else:
            require_command_ids(
                release.get("result_command"),
                "release result_command",
                "pass",
                single=True,
            )
        parent = _dict(evidence.get("parent_attestation"))
        if migration:
            if parent:
                r.error("migration release must not carry a legacy parent_attestation")
        elif not parent:
            r.error("release attestation requires a parent merge attestation")
        else:
            if parent.get("stage") != "merge" or parent.get("status") != "accepted":
                r.error("parent merge attestation must be accepted at merge stage")
            for field_name in ["attestation_id", "digest", "contract_fingerprint", "candidate_revision"]:
                if not _nonempty(parent.get(field_name)):
                    r.error(f"parent merge attestation requires {field_name}")
            if parent.get("contract_fingerprint") != contract_ref.get("fingerprint"):
                r.error("parent merge attestation contract fingerprint differs")
            if parent.get("candidate_revision") != candidate.get("revision"):
                r.error("parent merge attestation candidate revision differs")

    if not _nonempty(evidence.get("retained_at")):
        r.error("evidence.retained_at must be non-empty")
    issued_timestamp = _timestamp(evidence.get("issued_at"))
    if not _nonempty(evidence.get("issued_at")):
        r.error("evidence.issued_at must be non-empty")
    elif issued_timestamp is None:
        r.error("evidence.issued_at must be an ISO-8601 timestamp")

    if contract is not None:
        contract_result = validate_contract(contract)
        for message in contract_result.errors:
            r.error(f"linked contract invalid: {message}")
        for message in contract_result.warnings:
            r.warn(f"linked contract warning: {message}")
        contract_fixtures = {
            fixture.get("name"): fixture.get("fingerprint")
            for fixture in _list(contract.get("fixtures"))
            if isinstance(fixture, dict)
        }
        evidence_fixtures = {
            fixture.get("name"): fixture.get("fingerprint")
            for fixture in _list(evidence.get("fixtures"))
            if isinstance(fixture, dict)
        }
        if evidence_fixtures != contract_fixtures:
            r.error("fixture identities differ from qualified contract")
        expected_contract_fingerprint = contract_fingerprint(contract)
        if contract_ref.get("fingerprint") != expected_contract_fingerprint:
            r.error("evidence contract fingerprint differs from linked contract content")
        contract_revision = contract.get("revision")
        if _nonempty(contract_revision) and contract_ref.get("revision") != contract_revision:
            r.error("evidence contract revision differs from linked contract")
        if evidence.get("objective_id") != contract.get("objective_id"):
            r.error("evidence.objective_id does not match contract")
        if mode != contract.get("mode"):
            r.error("evidence.mode does not match contract")
        if (
            status == "accepted"
            and mode == "characterization"
            and _dict(contract.get("intent")).get("status") != "validated"
        ):
            r.error("accepted characterization requires validated intent")
        if risk != contract.get("risk_profile"):
            r.error("evidence.risk_profile does not match contract")
        if environment.get("digest") != _dict(contract.get("environment")).get("digest"):
            r.error("environment digest differs from qualified contract identity")
        if risk == "critical":
            declared_matrix = [
                item
                for item in _list(_dict(contract.get("environment")).get("matrix"))
                if _nonempty(item)
            ]
            if not declared_matrix:
                r.error("critical contract environment.matrix must declare supported platforms")
            contract_environment = _dict(contract.get("environment"))
            external_aggregator = (
                len(declared_matrix) > 1
                and contract_environment.get("platform_evidence_authority")
                == "external-attestation-aggregator"
            )
            if len(declared_matrix) > 1 and not external_aggregator:
                r.error(
                    "critical multi-platform acceptance requires "
                    "environment.platform_evidence_authority="
                    "'external-attestation-aggregator'"
                )

            platform_result_plans = _dict(
                _dict(contract.get("control_plane")).get("platform_results")
            )
            details = _dict(environment.get("details"))
            matrix_evidence = _dict(details.get("platform_matrix_evidence"))
            runtime = _dict(details.get("runtime"))
            runtime_platform_id = runtime.get("platform_id")
            if not matrix_evidence:
                r.error("critical platform matrix lacks authenticated execution evidence")
            missing_platforms = sorted(
                platform
                for platform in declared_matrix
                if matrix_evidence.get(platform)
                != _dict(platform_result_plans.get(platform)).get("command_id")
                or not _nonempty(matrix_evidence.get(platform))
            )
            extra_platforms = sorted(
                platform
                for platform in matrix_evidence
                if platform not in set(declared_matrix)
            )
            if missing_platforms:
                r.error(
                    "critical platform matrix lacks authenticated execution evidence"
                    f" for: {missing_platforms}"
                )
            if extra_platforms:
                r.error(
                    "critical platform matrix evidence contains undeclared platforms: "
                    f"{extra_platforms}"
                )

            if external_aggregator:
                attestation_digests = _dict(
                    details.get("platform_attestation_digests")
                )
                missing_attestations = sorted(
                    platform
                    for platform in declared_matrix
                    if not _nonempty(attestation_digests.get(platform))
                )
                extra_attestations = sorted(
                    platform
                    for platform in attestation_digests
                    if platform not in set(declared_matrix)
                )
                malformed_attestations = sorted(
                    platform
                    for platform in declared_matrix
                    if _nonempty(attestation_digests.get(platform))
                    and not _is_digest(attestation_digests.get(platform))
                )
                if missing_attestations:
                    r.error(
                        "critical external platform aggregation lacks attestation "
                        f"digests for: {missing_attestations}"
                    )
                if extra_attestations:
                    r.error(
                        "critical external platform aggregation contains undeclared "
                        f"attestation digests: {extra_attestations}"
                    )
                if malformed_attestations:
                    r.error(
                        "critical external platform aggregation requires "
                        "sha256:<64-hex> attestation digests for: "
                        f"{malformed_attestations}"
                    )
            elif len(declared_matrix) == 1:
                sole_platform = declared_matrix[0]
                if not _nonempty(runtime_platform_id):
                    r.error(
                        "critical platform matrix requires "
                        "environment.details.runtime.platform_id"
                    )
                elif sole_platform != runtime_platform_id:
                    r.error(
                        "critical platform matrix key must equal "
                        f"environment.details.runtime.platform_id "
                        f"({sole_platform!r} != {runtime_platform_id!r})"
                    )

            for platform in declared_matrix:
                plan_spec = _dict(platform_result_plans.get(platform))
                command_id = plan_spec.get("command_id")
                mapped_command_id = matrix_evidence.get(platform)
                if mapped_command_id != command_id or not _nonempty(command_id):
                    continue
                command = command_records.get(command_id)
                if command is None or command.get("result") != "pass":
                    r.error(
                        "critical platform matrix lacks authenticated execution evidence"
                        f" for: {[platform]}"
                    )
                    continue
                captured = _dict(command.get("captured_result"))
                captured_value = _dict(captured.get("value"))
                if (
                    captured_value.get("platform") != platform
                    or captured_value.get("passed") is not True
                ):
                    r.error(
                        "critical protected platform result is missing or mismatched"
                        f" for: {platform}"
                    )


        discovery_baseline = _dict(contract.get("test_discovery"))
        for field_name in ["manifest_digest", "expected"]:
            if discovery.get(field_name) != discovery_baseline.get(field_name):
                r.error(f"test discovery baseline {field_name} differs from contract")
        baseline_skips = set(_list(discovery_baseline.get("approved_skips")))
        if approved_skips != baseline_skips:
            r.error("test discovery baseline approved_skips differs from contract")
        baseline_shards = {
            shard.get("id"): shard.get("expected")
            for shard in _list(discovery_baseline.get("shards"))
            if isinstance(shard, dict)
        }
        if set(discovery_shards) != set(baseline_shards):
            r.error("test discovery shard identities differ from contract baseline")
        for shard_id, shard_expected in baseline_shards.items():
            observed_shard = discovery_shards.get(shard_id)
            if observed_shard is not None and observed_shard.get("discovered") != shard_expected:
                r.error(f"test discovery shard {shard_id} differs from contract baseline")
        commands_by_text: dict[str, list[dict[str, Any]]] = {}
        command_positions: dict[str, int] = {}
        for position, raw_command in enumerate(commands):
            command = _dict(raw_command)
            command_text = command.get("command")
            command_id = command.get("id")
            if _nonempty(command_id):
                command_positions[command_id] = position
            if _nonempty(command_text):
                commands_by_text.setdefault(command_text, []).append(command)

        def require_execution(command_text: Any, label: str, expected_result: str) -> None:
            if not _nonempty(command_text):
                return
            records = commands_by_text.get(command_text, [])
            if not records:
                r.error(f"{label} was not executed")
            elif status == "accepted" and not any(
                record.get("result") == expected_result for record in records
            ):
                r.error(f"{label} lacks result {expected_result}")

        baseline = _dict(contract.get("baseline"))
        if mode == "characterization":
            known_good = (
                baseline.get("reference_green_command")
                or baseline.get("semantic_green_command")
            )
            require_execution(known_good, "characterization GREEN command", "pass")
        elif mode == "construction":
            require_execution(
                baseline.get("semantic_red_command"),
                "semantic RED command",
                "expected_reject",
            )
        elif mode == "equivalence":
            require_execution(
                baseline.get("reference_green_command"),
                "reference GREEN command",
                "pass",
            )
        elif mode == "improvement":
            require_execution(
                baseline.get("semantic_green_command"),
                "semantic GREEN command",
                "pass",
            )
            metric = _dict(baseline.get("metric"))
            require_execution(
                metric.get("baseline_command"),
                "metric baseline command",
                "pass",
            )
        gates = _dict(contract.get("gates"))
        require_execution(gates.get("focused"), "focused gate", "pass")
        if stage in {"cutover", "merge", "release"}:
            require_execution(gates.get("broad"), "broad gate", "pass")
            require_execution(gates.get("integration"), "integration gate", "pass")
            require_execution(gates.get("merge"), "merge gate", "pass")
        if stage == "release":
            require_execution(gates.get("release"), "release gate", "pass")

        contract_claims = {item.get("id") for item in _list(contract.get("claims")) if isinstance(item, dict)}
        missing_claims = sorted(cid for cid in contract_claims if cid not in claim_status)
        extra_claims = sorted(cid for cid in claim_status if cid not in contract_claims)
        if missing_claims:
            r.error(f"evidence is missing contract claim results: {missing_claims}")
        if extra_claims:
            r.error(f"evidence contains unknown claim results: {extra_claims}")

        contract_defeaters = {item.get("id"): item for item in _list(contract.get("defeaters")) if isinstance(item, dict)}
        for did, item in contract_defeaters.items():
            expected_status = item.get("status")
            observed = defeater_status.get(did)
            if observed is None:
                r.error(f"evidence is missing contract defeater result: {did}")
            elif expected_status == "covered" and observed != "eliminated":
                r.error(f"covered defeater {did} must be eliminated in accepted evidence, observed {observed}")
            elif expected_status == "accepted_residual" and observed != "accepted_residual":
                r.error(f"residual defeater {did} must remain explicitly accepted_residual")
            elif expected_status == "unknown" and status == "accepted":
                r.error(f"contract defeater {did} is unknown and blocks accepted evidence")
            if expected_status == "accepted_residual":
                acceptance = _dict(item.get("risk_acceptance"))
                record = residual_records.get(did)
                if record is None:
                    r.error(f"accepted evidence is missing residual risk record for {did}")
                else:
                    if record.get("owner") != acceptance.get("owner"):
                        r.error(f"residual risk {did} owner differs from contract")
                    if record.get("rationale") != acceptance.get("rationale"):
                        r.error(f"residual risk {did} rationale differs from contract")
                    if record.get("stage") != stage or stage not in _list(acceptance.get("stages")):
                        r.error(f"residual risk {did} is not accepted for stage {stage}")
                    if record.get("expires_at") != acceptance.get("expires_at"):
                        r.error(f"residual risk {did} expiry differs from contract")
                    if not _nonempty(record.get("decision_ref")):
                        r.error(f"residual risk {did} requires decision_ref")
                    expiry_timestamp = _timestamp(acceptance.get("expires_at"))
                    if (
                        issued_timestamp is not None
                        and expiry_timestamp is not None
                        and expiry_timestamp <= issued_timestamp
                    ):
                        r.error(f"residual risk {did} expired before evidence issuance")
                    if _list(record.get("invalidated_by")) != _list(acceptance.get("invalidated_by")):
                        r.error(f"residual risk {did} invalidation conditions differ from contract")
        extra_residuals = sorted(did for did in residual_records if did not in contract_defeaters)
        if extra_residuals:
            r.error(f"evidence contains residual risks absent from contract: {extra_residuals}")

        contract_oracles = {item.get("id"): item for item in _list(contract.get("oracles")) if isinstance(item, dict)}
        qualification_texts: set[str] = set()
        qualification_defeaters: set[str] = set()
        for oracle in contract_oracles.values():
            qualification = _dict(oracle.get("qualification"))
            for field_name in ["known_good_command", "restore_command"]:
                value = qualification.get(field_name)
                if _nonempty(value):
                    qualification_texts.add(value)
            qualification_defeaters.update(
                case.get("defeater_id")
                for case in _list(qualification.get("known_bad_cases"))
                if isinstance(case, dict) and _nonempty(case.get("defeater_id"))
            )
        reference_green_command = _dict(contract.get("baseline")).get(
            "reference_green_command"
        )
        if _nonempty(reference_green_command):
            qualification_texts.add(reference_green_command)
        for oid, oracle in contract_oracles.items():
            observed = oracle_evidence.get(oid)
            if observed is None:
                r.error(f"evidence is missing contract oracle {oid}")
                continue
            for identity_field in ["revision", "fingerprint"]:
                if observed.get(identity_field) != oracle.get(identity_field):
                    r.error(f"oracle {oid} {identity_field} differs from qualified contract identity")
            qualification = _dict(oracle.get("qualification"))
            qualification_status = qualification.get("status", "fresh")
            required_trials = qualification.get(
                "required_no_change_trials",
                qualification.get("no_change_trials", 0),
            )
            observed_trials = observed.get("no_change_trials")
            if (
                isinstance(required_trials, int)
                and isinstance(observed_trials, int)
                and observed_trials < required_trials
            ):
                r.error(
                    f"oracle {oid} has {observed_trials} no-change trials; "
                    f"{required_trials} required"
                )
            max_flake = qualification.get("max_flake_rate")
            observed_flake = observed.get("flake_rate")
            if (
                isinstance(max_flake, (int, float))
                and isinstance(observed_flake, (int, float))
                and observed_flake > max_flake
            ):
                r.error(f"oracle {oid} flake rate exceeds qualified maximum")

            if qualification_status == "reused":
                if observed.get("qualification_attestation_id") != qualification.get(
                    "prior_attestation_id"
                ):
                    r.error(f"reused oracle {oid} lacks its qualification attestation")
                if observed.get("qualification_attestation_digest") != qualification.get(
                    "prior_attestation_digest"
                ):
                    r.error(f"reused oracle {oid} qualification attestation digest differs")
                if observed.get("qualification_contract_fingerprint") != qualification.get(
                    "qualification_contract_fingerprint"
                ):
                    r.error(
                        f"reused oracle {oid} qualification contract fingerprint differs"
                    )
                required_defeaters = set(
                    _list(qualification.get("covered_defeater_ids"))
                )
            else:
                require_execution(
                    qualification.get("known_good_command"),
                    f"oracle {oid} known-good command",
                    "pass",
                )
                require_execution(
                    qualification.get("restore_command"),
                    f"oracle {oid} restore command",
                    "pass",
                )
                required_defeaters = {
                    case.get("defeater_id")
                    for case in _list(qualification.get("known_bad_cases"))
                    if isinstance(case, dict)
                }
                known_good_positions = [
                    command_positions.get(command.get("id"), -1)
                    for command in commands_by_text.get(
                        qualification.get("known_good_command"), []
                    )
                    if command.get("result") == "pass"
                ]
                stability_command_ids = _list(
                    qualification.get("stability_command_ids")
                )
                stability_positions: list[int] = []
                stability_failures = 0
                for command_id in stability_command_ids:
                    command = command_records.get(command_id)
                    if command is None:
                        if status == "accepted":
                            r.error(
                                f"oracle {oid} stability command {command_id} was not executed"
                            )
                        continue
                    command_result = command.get("result")
                    if (
                        command_result not in {"pass", "fail"}
                        or command.get("command")
                        != qualification.get("known_good_command")
                    ):
                        r.error(
                            f"oracle {oid} stability command {command_id} must run "
                            "the known-good command and record pass or fail"
                        )
                    if command_result == "fail":
                        stability_failures += 1
                    stability_positions.append(
                        command_positions.get(command_id, -1)
                    )
                derived_flake_rate = (
                    stability_failures / len(stability_command_ids)
                    if stability_command_ids
                    else 0.0
                )
                if status == "accepted" and observed_trials != len(
                    stability_command_ids
                ):
                    r.error(
                        f"oracle {oid} no-change trial count differs from explicit "
                        "stability commands"
                    )
                if (
                    status == "accepted"
                    and isinstance(observed_flake, (int, float))
                    and not math.isclose(
                        float(observed_flake),
                        derived_flake_rate,
                        rel_tol=0.0,
                        abs_tol=1e-12,
                    )
                ):
                    r.error(
                        f"oracle {oid} flake rate differs from explicit stability commands"
                    )
                restore_positions = [
                    command_positions.get(command.get("id"), -1)
                    for command in commands_by_text.get(
                        qualification.get("restore_command"), []
                    )
                    if command.get("result") == "pass"
                    and command.get("id") not in stability_command_ids
                ]
                rejection_positions = [
                    command_positions.get(command.get("id"), -1)
                    for command in command_records.values()
                    if command.get("result") == "expected_reject"
                    and required_defeaters.intersection(
                        set(_list(command.get("defeater_ids")))
                        | set(_list(command.get("artifact_refs")))
                    )
                ]
                if (
                    status == "accepted"
                    and stability_positions
                    and restore_positions
                    and min(stability_positions) <= max(restore_positions)
                ):
                    r.error(
                        f"oracle {oid} stability commands must run after restoration"
                    )
                if status == "accepted" and rejection_positions:
                    if not known_good_positions or min(known_good_positions) >= min(
                        rejection_positions
                    ):
                        r.error(
                            f"oracle {oid} known-good must run before known-bad rejection"
                        )
                    if not restore_positions or max(restore_positions) <= max(
                        rejection_positions
                    ):
                        r.error(
                            f"oracle {oid} restoration must run after known-bad rejection"
                        )
                    else:
                        restore_position = max(restore_positions + stability_positions)
                        for command in command_records.values():
                            command_position = command_positions.get(command.get("id"), -1)
                            command_tags = set(_list(command.get("defeater_ids"))) | set(
                                _list(command.get("artifact_refs"))
                            )
                            is_qualification_rejection = (
                                command.get("result") == "expected_reject"
                                and bool(qualification_defeaters.intersection(command_tags))
                            )
                            if (
                                command_position <= restore_position
                                and not is_qualification_rejection
                                and command.get("command") not in qualification_texts
                            ):
                                r.error(
                                    f"candidate evidence command {command.get('id')} ran "
                                    f"before oracle {oid} restoration"
                                )

            observed_rejections = set(_list(observed.get("known_bad_rejections")))
            missing_rejections = sorted(
                did for did in required_defeaters if did and did not in observed_rejections
            )
            if status == "accepted" and missing_rejections:
                r.error(
                    f"oracle {oid} lacks required known-bad rejection evidence: "
                    f"{missing_rejections}"
                )
            if qualification_status == "fresh":
                rejection_evidence = {
                    artifact_ref
                    for command in commands
                    if _dict(command).get("result") == "expected_reject"
                    for artifact_ref in _list(_dict(command).get("artifact_refs"))
                }
                missing_command_evidence = sorted(
                    did for did in required_defeaters if did and did not in rejection_evidence
                )
                if status == "accepted" and missing_command_evidence:
                    r.error(
                        f"oracle {oid} known-bad rejections lack command evidence: "
                        f"{missing_command_evidence}"
                    )

        roles = _dict(contract.get("roles"))
        if status == "accepted" and risk in {"standard", "critical"} and issuer.get("identity") != roles.get("acceptor"):
            r.error("evidence issuer does not match contract.roles.acceptor")
        if status == "accepted" and stage == "release" and release.get("release_owner") != roles.get("release_owner"):
            r.error("release owner differs from contract.roles.release_owner")

    return r


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"top-level JSON in {path} must be an object")
    return value


def _schema_errors(value: dict[str, Any], schema_name: str) -> list[str]:
    schema_path = Path(__file__).resolve().parents[1] / "schemas" / schema_name
    schema = load_json(schema_path)
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(value), key=lambda error: list(error.path))
    rendered = []
    for error in errors:
        location = ".".join(str(part) for part in error.path) or "<root>"
        rendered.append(f"schema {location}: {error.message}")
    return rendered


def _merge_errors(result: LintResult, errors: Iterable[str]) -> LintResult:
    result.errors[:0] = list(errors)
    return result


def print_result(label: str, result: LintResult) -> None:
    if result.ok:
        print(f"PASS {label}")
    else:
        print(f"FAIL {label}")
    for warning in result.warnings:
        print(f"WARN  {warning}")
    for error in result.errors:
        print(f"ERROR {error}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lint VDD 0.4 JSON contracts and evidence attestations")
    sub = parser.add_subparsers(dest="command", required=True)
    contract_parser = sub.add_parser("contract", help="lint an objective contract")
    contract_parser.add_argument("file", type=Path)
    evidence_parser = sub.add_parser("evidence", help="lint an evidence attestation")
    evidence_parser.add_argument("file", type=Path)
    evidence_parser.add_argument("--contract", type=Path, help="cross-check against the objective contract")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "contract":
            contract = load_json(args.file)
            result = _merge_errors(
                validate_contract(contract),
                _schema_errors(contract, "contract.schema.json"),
            )
            print_result(str(args.file), result)
            return 0 if result.ok else 1
        evidence = load_json(args.file)
        contract = load_json(args.contract) if args.contract else None
        schema_errors = _schema_errors(evidence, "evidence.schema.json")
        if contract is not None:
            schema_errors.extend(_schema_errors(contract, "contract.schema.json"))
        result = _merge_errors(validate_evidence(evidence, contract), schema_errors)
        print_result(str(args.file), result)
        return 0 if result.ok else 1
    except ValueError as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
