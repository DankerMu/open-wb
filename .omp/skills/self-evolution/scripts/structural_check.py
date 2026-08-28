#!/usr/bin/env python3
"""L1 structural and safety checks for any artifact type.

Usage:
    python structural_check.py <artifact-path> --type <prompt|skill|code|experiment|idea|config|custom>
    python structural_check.py <artifact-path> --type code --language python
    python structural_check.py <artifact-path> --type experiment --language python --plan-path evolve_plan.md
    python structural_check.py <artifact-path> --type skill

Output: JSON with check results and overall pass/fail.
Exit code: 0 if all critical checks pass, 1 if any critical check fails.
"""

import argparse
import json
import os
import re
import subprocess
import sys


DANGEROUS_PATTERNS = [
    (r"rm\s+-rf\s+/(?!\S)", "Dangerous delete: rm -rf /", True, re.IGNORECASE),
    (r"rm\s+-rf\s+~", "Dangerous delete: rm -rf ~", True, re.IGNORECASE),
    (r"DROP\s+TABLE", "Dangerous SQL: DROP TABLE", True, 0),
    (r"DROP\s+DATABASE", "Dangerous SQL: DROP DATABASE", True, 0),
    (r"TRUNCATE\s+TABLE", "Dangerous SQL: TRUNCATE TABLE", True, 0),
    (r"(?:AKIA|ASIA)[A-Z0-9]{16}", "Possible AWS access key", True, 0),
    (r"sk-[a-zA-Z0-9]{20,}", "Possible API key (sk-...)", True, 0),
    (r"password\s*=\s*['\"][^'\"]{8,}['\"]", "Hardcoded password", True, re.IGNORECASE),
    (r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}", "Possible GitHub token", True, 0),
    (r"(?:/Users/|/home/|C:\\\\Users\\\\)[^\s'\"]+", "Hardcoded user path", False, 0),
    (r"sudo\s+", "Uses sudo", False, 0),
    (r"chmod\s+777", "Overly permissive chmod 777", False, 0),
    (r"(?<![A-Za-z])eval\s*\(", "Uses eval()", False, 0),
    (r"(?<![A-Za-z])exec\s*\(", "Uses exec()", False, 0),
]


def check_file_exists(path):
    if os.path.exists(path):
        return True, f"Artifact exists: {path}"
    return False, f"Artifact not found: {path}"


def check_non_empty(path):
    if os.path.isdir(path):
        files = os.listdir(path)
        if files:
            return True, f"Directory has {len(files)} items"
        return False, "Directory is empty"
    if os.path.getsize(path) > 0:
        return True, f"File size: {os.path.getsize(path)} bytes"
    return False, "File is empty"


def check_not_binary(path):
    if os.path.isdir(path):
        return True, "Directory (skip binary check)"
    try:
        with open(path, "rb") as f:
            chunk = f.read(8192)
        null_count = chunk.count(b"\x00")
        if null_count > len(chunk) * 0.1:
            return False, f"Appears to be binary ({null_count} null bytes in first 8KB)"
        return True, "Text file"
    except Exception as e:
        return False, f"Read error: {e}"


def safety_scan(path, exclude_paths=None):
    results = []
    files_to_scan = []
    exclude_paths = set(os.path.abspath(p) for p in (exclude_paths or []))

    if os.path.isdir(path):
        for root, _, files in os.walk(path):
            for f in files:
                fp = os.path.join(root, f)
                if os.path.abspath(fp) in exclude_paths:
                    continue
                if any(skip in fp for skip in [".git/", "__pycache__", "node_modules"]):
                    continue
                files_to_scan.append(fp)
    else:
        files_to_scan.append(path)

    for fp in files_to_scan:
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception:
            continue

        for pattern, description, is_critical, flags in DANGEROUS_PATTERNS:
            matches = list(re.finditer(pattern, content, flags))
            if matches:
                for m in matches[:3]:
                    line_num = content[:m.start()].count("\n") + 1
                    results.append({
                        "file": os.path.relpath(fp, path) if os.path.isdir(path) else os.path.basename(fp),
                        "line": line_num,
                        "pattern": description,
                        "critical": is_critical,
                        "match": m.group()[:80],
                    })

    return results


def check_skill_structure(path):
    skill_md = os.path.join(path, "SKILL.md") if os.path.isdir(path) else path
    if not os.path.exists(skill_md):
        return False, "SKILL.md not found"

    with open(skill_md, "r", encoding="utf-8") as f:
        content = f.read()

    if not content.startswith("---"):
        return False, "Missing YAML frontmatter"

    parts = content.split("---", 2)
    if len(parts) < 3:
        return False, "Incomplete YAML frontmatter"

    frontmatter = parts[1]
    if "name:" not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if "description:" not in frontmatter:
        return False, "Missing 'description' in frontmatter"

    body = parts[2].strip()
    if len(body) < 50:
        return False, f"Body too short ({len(body)} chars)"

    return True, "Valid SKILL.md structure"


def check_code_syntax(path, language):
    if language == "python":
        if os.path.isdir(path):
            py_files = []
            for root, _, files in os.walk(path):
                for f in files:
                    if f.endswith(".py"):
                        py_files.append(os.path.join(root, f))
        else:
            py_files = [path]

        for fp in py_files:
            result = subprocess.run(
                [sys.executable, "-m", "py_compile", fp],
                capture_output=True, text=True
            )
            if result.returncode != 0:
                return False, f"Syntax error in {os.path.basename(fp)}: {result.stderr[:200]}"
        return True, f"All {len(py_files)} Python files pass syntax check"

    elif language == "javascript" or language == "typescript":
        return True, "JS/TS syntax check requires node (skipped)"

    elif language == "go":
        result = subprocess.run(
            ["go", "vet", path],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            return True, "go vet passed"
        return False, f"go vet failed: {result.stderr[:200]}"

    return True, f"No syntax checker for {language} (skipped)"


def check_gt_sample(gt_path, sample_size=3):
    if not os.path.exists(gt_path):
        return True, "No GT file to check (will be created during setup)"

    try:
        with open(gt_path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return False, f"GT file is invalid JSON: {e}"

    cases = data.get("cases", data.get("evals", []))
    if not cases:
        return False, "GT file has no test cases"

    import random
    sample = random.sample(cases, min(sample_size, len(cases)))

    for case in sample:
        if "id" not in case:
            return False, f"GT case missing 'id': {json.dumps(case)[:100]}"
        if "prompt" not in case:
            return False, f"GT case {case.get('id', '?')} missing 'prompt'"
        assertions = case.get("assertions", case.get("expectations", []))
        if not assertions:
            return False, f"GT case {case.get('id', '?')} has no assertions"

    return True, f"Sampled {len(sample)} GT cases — all valid"

SCOREBOARD_FIELDS = [
    "editable_scope",
    "forbidden_scope",
    "run_command",
    "metric_name",
    "metric_direction",
    "metric_parse_rule",
    "timeout_seconds",
    "total_budget",
    "execution_model_tier",
]


def check_scoreboard_plan(plan_path):
    if not plan_path:
        return False, "Scoreboard plan path not provided"
    if not os.path.exists(plan_path):
        return False, f"Scoreboard plan not found: {plan_path}"

    with open(plan_path, "r", encoding="utf-8") as f:
        content = f.read()

    missing = []
    values = {}
    for field in SCOREBOARD_FIELDS:
        match = re.search(rf"(?m)^\s*{re.escape(field)}\s*:\s*(.+)$", content)
        if not match or not match.group(1).strip():
            missing.append(field)
        else:
            values[field] = match.group(1).strip()

    if missing:
        return False, f"Scoreboard plan missing fields: {', '.join(missing)}"

    direction = values["metric_direction"]
    if direction not in {"minimize", "maximize"}:
        return False, "metric_direction must be 'minimize' or 'maximize'"

    return True, "Scoreboard plan has required contract fields"


def check_scope_violation(forbidden, diff_base):
    """Fail if the mutation touched anything declared forbidden.

    The contract says the loop may not edit its own oracle. This turns that
    from a promise into a check: whatever the mutation claims to have done,
    the diff either stayed inside editable scope or it did not.
    """
    if not forbidden:
        return True, "No forbidden scope declared — check skipped"

    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", diff_base],
            capture_output=True, text=True, timeout=30,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        return False, f"Could not read git diff against {diff_base}: {exc}"

    if result.returncode != 0:
        return False, f"git diff against {diff_base} failed: {result.stderr.strip()[:200]}"

    changed = [p for p in result.stdout.splitlines() if p.strip()]
    if not changed:
        return True, f"No files changed since {diff_base}"

    violations = []
    for path in changed:
        for pattern in forbidden:
            normalized = pattern.rstrip("/")
            if path == normalized or path.startswith(normalized + "/"):
                violations.append(f"{path} (forbidden: {pattern})")
                break

    if violations:
        return False, f"Mutation touched forbidden scope: {'; '.join(violations)}"

    return True, f"All {len(changed)} changed files are inside editable scope"




def run_checks(path, artifact_type, language=None, gt_path=None, exclude_paths=None, plan_path=None,
               forbidden=None, diff_base=None):
    checks = []

    passed, msg = check_file_exists(path)
    checks.append({"name": "file_exists", "critical": True, "passed": passed, "message": msg})
    if not passed:
        return checks

    passed, msg = check_non_empty(path)
    checks.append({"name": "non_empty", "critical": True, "passed": passed, "message": msg})

    if artifact_type != "code":
        passed, msg = check_not_binary(path)
        checks.append({"name": "not_binary", "critical": True, "passed": passed, "message": msg})

    safety_results = safety_scan(path, exclude_paths)
    criticals = [r for r in safety_results if r["critical"]]
    warnings = [r for r in safety_results if not r["critical"]]

    checks.append({
        "name": "safety_scan",
        "critical": len(criticals) > 0,
        "passed": len(criticals) == 0,
        "message": f"{len(criticals)} critical, {len(warnings)} warnings",
        "details": safety_results,
    })

    # A skill must have a valid SKILL.md — a missing one is a failure, never a
    # skipped check. A harness need not be skill-shaped at all, so it is only
    # validated when a SKILL.md is actually present.
    if artifact_type == "skill" or (
        artifact_type == "harness" and os.path.isdir(path)
        and os.path.exists(os.path.join(path, "SKILL.md"))
    ):
        passed, msg = check_skill_structure(path)
        checks.append({"name": "skill_structure", "critical": True, "passed": passed, "message": msg})

    if diff_base:
        passed, msg = check_scope_violation(forbidden, diff_base)
        checks.append({"name": "scope_violation", "critical": True, "passed": passed, "message": msg})

    if artifact_type in ("code", "experiment") and language:
        passed, msg = check_code_syntax(path, language)
        checks.append({"name": "syntax_check", "critical": True, "passed": passed, "message": msg})

    if gt_path:
        passed, msg = check_gt_sample(gt_path)
        checks.append({"name": "gt_sample", "critical": True, "passed": passed, "message": msg})

    if artifact_type == "experiment":
        passed, msg = check_scoreboard_plan(plan_path)
        checks.append({"name": "scoreboard_plan", "critical": True, "passed": passed, "message": msg})


    return checks


def main():
    parser = argparse.ArgumentParser(description="L1 structural check for artifacts")
    parser.add_argument("artifact_path", help="Path to the artifact")
    parser.add_argument("--type", required=True,
                        choices=["prompt", "skill", "harness", "code", "experiment", "idea", "config", "custom"])
    parser.add_argument("--language", help="Programming language (for code/experiment type)")
    parser.add_argument("--gt-path", help="Path to GT file for sample check")
    parser.add_argument("--exclude", nargs="*", default=[], help="File paths to exclude from safety scan")
    parser.add_argument("--plan-path", help="Scoreboard evolve_plan.md path for experiment checks")
    parser.add_argument("--forbidden", nargs="*", default=[],
                        help="Repo-relative paths the mutation must not touch (forbidden scope)")
    parser.add_argument("--diff-base", default=None,
                        help="Git ref to diff against for the scope-violation check, e.g. HEAD~1")

    args = parser.parse_args()

    checks = run_checks(args.artifact_path, args.type, args.language, args.gt_path, args.exclude,
                        args.plan_path, args.forbidden, args.diff_base)

    critical_failures = [c for c in checks if c["critical"] and not c["passed"]]
    all_passed = len(critical_failures) == 0

    output = {
        "artifact_path": args.artifact_path,
        "artifact_type": args.type,
        "all_critical_passed": all_passed,
        "checks": checks,
        "summary": {
            "total": len(checks),
            "passed": sum(1 for c in checks if c["passed"]),
            "failed_critical": len(critical_failures),
            "failed_warning": sum(1 for c in checks if not c["critical"] and not c["passed"]),
        },
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
