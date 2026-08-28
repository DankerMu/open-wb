#!/usr/bin/env python3
"""Aggregate per-case judgements into the L2 results object.

    ./self/aggregate.py <out-dir> [--skill <pinned-skill-dir>]
    ./self/aggregate.py <dir-1> <dir-2> <dir-3> --skill <s>   # mean and spread

Writes <out-dir>/l2_results.json in the shape references/evaluation.md
specifies, reading <out-dir>/judge/*.json and <out-dir>/runs/.

Crashed cases are listed separately rather than scored zero. A crash carries no
behavioural information, and folding it into the pass rate turns an
infrastructure failure into what looks like a regression.
"""

import argparse
import glob
import json
import os


def summarize_repeats(out_dirs, skill):
    """Report mean and spread per case across independent repeats of the suite.

    evaluation.md requires a spread, not a point estimate, before a number gates
    anything. It is not decoration: one case measured 5/5 and 2/5 on two runs of
    the same artifact, so a single-run delta on that surface is indistinguishable
    from noise, and mutating against it is chasing the judge.
    """
    per_case, rates, incomplete = {}, [], []
    for out_dir in out_dirs:
        path = os.path.join(out_dir, "l2_results.json")
        if not os.path.exists(path):
            incomplete.append(f"{out_dir} (no l2_results.json)")
            continue
        data = json.load(open(path))
        if not data.get("complete"):
            incomplete.append(f"{out_dir} (incomplete)")
            continue
        rates.append(data["dev_pass_rate"])
        for case in data["cases"]:
            per_case.setdefault(case["id"], []).append(case["pass_rate"])

    if incomplete:
        print("Excluded from the summary:")
        for item in incomplete:
            print(f"  {item}")
    if len(rates) < 2:
        print(f"Need at least 2 complete repeats to report a spread; have {len(rates)}.")
        raise SystemExit(4)

    def mean(xs):
        return sum(xs) / len(xs)

    def sd(xs):
        m = mean(xs)
        return (sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) ** 0.5

    print(f"skill: {skill}")
    print(f"repeats: {len(rates)}\n")
    print(f"{'case':<34}{'mean':<8}{'sd':<8}runs")
    print("-" * 64)
    unstable = []
    for case_id in sorted(per_case):
        vals = per_case[case_id]
        m, s = mean(vals), sd(vals) if len(vals) > 1 else 0.0
        flag = ""
        if s > 0.15:
            flag = "  <-- unstable"
            unstable.append(case_id)
        print(f"{case_id:<34}{m:<8.2f}{s:<8.2f}{[round(v, 2) for v in vals]}{flag}")
    print("-" * 64)
    print(f"{'dev_pass_rate':<34}{mean(rates):<8.4f}{sd(rates):<8.4f}"
          f"{[round(r, 4) for r in rates]}")
    if unstable:
        print(f"\nUnstable surfaces ({len(unstable)}): {', '.join(unstable)}")
        print("A single-run delta on these is not evidence. Do not mutate against them "
              "without repeating the measurement.")


def main():
    parser = argparse.ArgumentParser(description="Aggregate self-evolution L2 results")
    parser.add_argument("out_dir", nargs="+",
                        help="One out-dir, or several to report mean and spread across repeats")
    parser.add_argument("--skill", default="")
    args = parser.parse_args()

    if len(args.out_dir) > 1:
        summarize_repeats(args.out_dir, args.skill)
        return

    out_dir = args.out_dir[0]
    judge_dir = os.path.join(out_dir, "judge")
    runs_dir = os.path.join(out_dir, "runs")

    cases, crashed, unjudged = [], [], []
    passed = total = 0

    for path in sorted(glob.glob(os.path.join(judge_dir, "*.json"))):
        try:
            entry = json.load(open(path))
        except (OSError, json.JSONDecodeError):
            unjudged.append(os.path.basename(path).removesuffix(".json"))
            continue
        if entry.get("crashed"):
            crashed.append(entry["case"])
            continue
        if entry.get("judge_unavailable"):
            unjudged.append(entry["case"])
            continue
        passed += entry["passed"]
        total += entry["total"]
        cases.append({
            "id": entry["case"],
            "passed": entry["passed"],
            "total": entry["total"],
            "pass_rate": round(entry["passed"] / entry["total"], 4) if entry["total"] else 0.0,
            "failed_assertions": [r for r in entry["results"] if not r["passed"]],
            "trace_path": os.path.join(runs_dir, entry["case"], "_transcript.txt"),
        })

    # A pass rate computed over a partial suite is not a smaller measurement,
    # it is a different one, and it reads as a regression. Publishing the number
    # anyway is how a rate-limited run gets mistaken for a broken artifact.
    incomplete = crashed + unjudged
    complete = not incomplete

    result = {
        "skill_under_test": args.skill,
        "complete": complete,
        "dev_pass_rate": round(passed / total, 4) if (total and complete) else None,
        "assertions_passed": passed,
        "assertions_total": total,
        "oracle_runs": len(cases) + len(crashed),
        "crashed_cases": crashed,
        "unjudged_cases": unjudged,
        "cases": cases,
    }

    out_path = os.path.join(out_dir, "l2_results.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    if complete:
        print(f"dev_pass_rate: {result['dev_pass_rate']}  "
              f"({passed}/{total} assertions over {len(cases)} cases)")
        print(f"written: {out_path}")
        return

    print("INCOMPLETE — no dev_pass_rate produced.")
    if crashed:
        print(f"  crashed after retry ({len(crashed)}): {', '.join(crashed)}")
    if unjudged:
        print(f"  judge unavailable ({len(unjudged)}): {', '.join(unjudged)}")
    print(f"  {passed}/{total} assertions scored over {len(cases)} complete cases — "
          f"not comparable to a full run.")
    print(f"written: {out_path}")
    raise SystemExit(4)


if __name__ == "__main__":
    main()
