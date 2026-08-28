#!/usr/bin/env python3
"""Validate an eng-init readiness repair handoff JSON file."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gate_output import report  # noqa: E402

TERMINAL_DECISIONS = {
    "repaired",
    "no_op_already_passing",
    "blocked_missing_prerequisite",
    "pending_external",
    "not_locally_fixable",
}


def parse_registry(path: Path) -> dict[str, dict[str, str]]:
    registry: dict[str, dict[str, str]] = {}
    current: dict[str, str] | None = None
    for raw in path.read_text().splitlines():
        if raw.startswith("  - id: "):
            if current is not None:
                registry[current["id"]] = current
            current = {"id": raw.split(":", 1)[1].strip()}
            continue
        if current is None:
            continue
        match = re.match(r"^    ([a-z_]+):\s*(.*)$", raw.rstrip())
        if match:
            current[match.group(1)] = match.group(2).strip().strip('"').strip("'")
    if current is not None:
        registry[current["id"]] = current
    return registry


def fail_if(condition: bool, message: str, errors: list[str]) -> None:
    if condition:
        errors.append(message)


def validate(payload: dict, registry: dict[str, dict[str, str]]) -> list[str]:
    errors: list[str] = []
    required = ["schema_version", "requested_signal", "matched_criterion", "pre_state", "fixability", "allowed_files", "validator", "post_state", "decision"]
    for field in required:
        fail_if(field not in payload, f"missing required field: {field}", errors)
    cid = payload.get("matched_criterion")
    meta = registry.get(cid)
    fail_if(meta is None, f"matched_criterion is not in readiness registry: {cid!r}", errors)
    decision = payload.get("decision")
    fail_if(decision not in TERMINAL_DECISIONS, f"invalid decision: {decision!r}", errors)
    pre = payload.get("pre_state") or {}
    post = payload.get("post_state") or {}
    validator = payload.get("validator") or {}
    fail_if(not isinstance(payload.get("allowed_files"), list), "allowed_files must be a list", errors)
    fail_if(not validator.get("command"), "validator.command is required", errors)
    fail_if("exit_code" not in validator, "validator.exit_code is required", errors)
    fail_if(not validator.get("evidence"), "validator.evidence is required", errors)
    fail_if(not pre.get("evidence"), "pre_state.evidence is required", errors)
    fail_if(not post.get("rescore_evidence"), "post_state.rescore_evidence is required", errors)
    if meta is not None:
        fail_if(payload.get("fixability") != meta.get("fixability"), f"fixability {payload.get('fixability')!r} must match registry {meta.get('fixability')!r}", errors)
        # Class D external/governance controls cannot be faked by local files. They require pending/external disposition
        # unless authenticated external evidence is named explicitly in the validator evidence.
        if meta.get("fixability") == "D":
            evidence_text = str(validator.get("evidence", "")).lower()
            external_evidence = "authenticated" in evidence_text
            fake_local_completion = decision == "repaired" or post.get("status") == "passing"
            fail_if(fake_local_completion and not external_evidence, "Class D fake local completion rejected: use pending_external or provide authenticated external evidence", errors)
    if decision == "repaired":
        fail_if(validator.get("exit_code") != 0, "repaired decision requires validator.exit_code=0", errors)
        fail_if(post.get("status") not in {"passing", "partial", "skipped"}, "repaired decision requires passing/partial/skipped post_state", errors)
    if decision == "no_op_already_passing":
        fail_if(pre.get("status") != "passing" or post.get("status") != "passing", "no-op decision requires pre and post passing", errors)
    if decision in {"blocked_missing_prerequisite", "pending_external", "not_locally_fixable"}:
        fail_if(post.get("status") == "passing", f"{decision} cannot produce a passing post_state", errors)
    gaming = payload.get("metric_gaming_rejected", [])
    if cid in {"unit_tests_exist", "lint_config", "test_coverage_thresholds"} and decision == "repaired":
        fail_if(not gaming, f"{cid}: repaired handoff must record metric_gaming_rejected evidence", errors)
    return errors


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Validate eng-init readiness repair handoff JSON")
    parser.add_argument("handoff")
    parser.add_argument("--registry", default="references/readiness-registry.yaml")
    args = parser.parse_args(argv[1:])

    payload = json.loads(Path(args.handoff).read_text())
    registry = parse_registry(Path(args.registry))
    errors = validate(payload, registry)
    return report("validate-readiness-repair", errors,
                  f"repair handoff for {payload.get('matched_criterion')} conforms")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
