#!/usr/bin/env python3
"""Validate and rescore an eng-init readiness report JSON file."""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gate_output import report as gate_report  # noqa: E402  (aliased: local `report` holds the parsed JSON)


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


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def score(report: dict, registry: dict[str, dict[str, str]]) -> tuple[float, list[str]]:
    errors: list[str] = []
    apps = report.get("applications")
    require(isinstance(apps, list) and len(apps) >= 1, "applications must be a non-empty list", errors)
    app_count = len(apps) if isinstance(apps, list) else 0
    score_block = report.get("score", {})
    require(score_block.get("applications_identified") == app_count, "score.applications_identified must equal len(applications)", errors)
    criteria = report.get("criteria")
    require(isinstance(criteria, list), "criteria must be a list", errors)
    values: list[float] = []
    # Stop after recording the shape error rather than iterating a non-list: a
    # dict yields its keys and the row loop dies on `row.get`, turning a reported
    # violation into a traceback that loses every other finding. A gate reports;
    # it does not crash.
    if not isinstance(criteria, list):
        return 0.0, errors
    for index, row in enumerate(criteria, start=1):
        if not isinstance(row, dict):
            require(False, f"criteria[{index}] must be an object, got {type(row).__name__}", errors)
            continue
        cid = row.get("id")
        meta = registry.get(cid)
        require(meta is not None, f"criteria[{index}] unknown id {cid!r}", errors)
        denominator = row.get("denominator")
        numerator = row.get("numerator")
        status = row.get("status")
        if meta is not None:
            expected_denominator = 1 if meta.get("scope") == "repository" else app_count
            require(denominator == expected_denominator, f"{cid}: denominator {denominator!r} must be {expected_denominator}", errors)
            if numerator is None:
                require(meta.get("skippable") == "true" and status == "skipped", f"{cid}: null numerator requires skippable=true and skipped status", errors)
            else:
                require(isinstance(numerator, (int, float)), f"{cid}: numerator must be number or null", errors)
                require(isinstance(denominator, int) and denominator >= 1, f"{cid}: denominator must be positive integer", errors)
                if isinstance(numerator, (int, float)) and isinstance(denominator, int) and denominator >= 1:
                    require(0 <= numerator <= denominator, f"{cid}: numerator out of range", errors)
                    values.append(float(numerator) / float(denominator))
        require(row.get("evidence"), f"{cid}: evidence is required", errors)
        require(row.get("validator"), f"{cid}: validator is required", errors)
        require(row.get("rescore_rule"), f"{cid}: rescore_rule is required", errors)
    computed = sum(values) / len(values) if values else 0.0
    reported = score_block.get("average")
    require(isinstance(reported, (int, float)), "score.average must be numeric", errors)
    if isinstance(reported, (int, float)):
        require(math.isclose(computed, float(reported), rel_tol=0.0, abs_tol=0.0001), f"score.average {reported!r} does not match computed {computed:.6f}", errors)
    for cid in report.get("configured_but_not_blocking", []):
        rows = [row for row in criteria or [] if row.get("id") == cid]
        require(bool(rows), f"configured_but_not_blocking id {cid!r} missing from criteria", errors)
        for row in rows:
            require(row.get("status") == "partial", f"{cid}: configured-but-not-blocking rows must be partial", errors)
    return computed, errors


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Validate and rescore eng-init readiness report JSON")
    parser.add_argument("report")
    parser.add_argument("--registry", default="references/readiness-registry.yaml")
    args = parser.parse_args(argv[1:])

    report = json.loads(Path(args.report).read_text())
    registry = parse_registry(Path(args.registry))
    computed, errors = score(report, registry)
    if errors:
        return gate_report("score-readiness-report", errors, "")
    print(f"score: {computed:.6f}")
    print(f"criteria: {len(report.get('criteria', []))}")
    print(f"applications_identified: {len(report.get('applications', []))}")
    return gate_report("score-readiness-report", [],
                       f"{len(report.get('criteria', []))} criteria scored, all conform")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
