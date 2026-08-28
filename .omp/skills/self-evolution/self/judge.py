#!/usr/bin/env python3
"""Score one self-evolution GT case run. Blind: never told which version ran.

    ./self/judge.py <case-id> <run-dir> [--gt <path>] [--model <name>]

Prints one JSON object with per-assertion results.

The critical detail is what gets searched. An agent that does its work through
tools leaves almost nothing in the transcript — the run that was the *only* one
to produce `predictions.jsonl` summarized it in 184 characters. Judging the
transcript alone scored it 0/5 while two runs that produced nothing scored 3/5.
So assertions are evaluated against the transcript plus every file the run
created or modified, with untouched fixtures excluded so nothing passes free.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

SELF_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(SELF_DIR, "fixtures")
SKIP_PREFIXES = ("_", "references/", "scripts/")


def fixture_digests():
    digests = {}
    for path in glob.glob(f"{FIXTURES}/**/*", recursive=True):
        if os.path.isfile(path):
            with open(path, "rb") as f:
                digests[os.path.relpath(path, FIXTURES)] = hashlib.md5(f.read()).hexdigest()
    return digests


def produced_blob(work):
    """Transcript plus every file this run created or changed."""
    parts = []
    transcript = os.path.join(work, "_transcript.txt")
    if os.path.exists(transcript):
        parts.append(open(transcript, errors="replace").read())

    digests = fixture_digests()
    for path in sorted(glob.glob(f"{work}/**/*", recursive=True)):
        if not os.path.isfile(path):
            continue
        rel = os.path.relpath(path, work)
        if rel.startswith(SKIP_PREFIXES):
            continue
        try:
            with open(path, "rb") as f:
                if digests.get(rel) == hashlib.md5(f.read()).hexdigest():
                    continue
            parts.append(f"\n--- file: {rel} ---\n" + open(path, errors="replace").read())
        except OSError:
            continue
    return "\n".join(parts)


class JudgeUnavailable(RuntimeError):
    """The judge could not be reached. Not the same as judging NO."""


# `claude` reports quota exhaustion as ordinary stdout with exit 1, so an
# unguarded judge reads it as prose and scores every criterion NO. A whole
# suite came back at 0.24 that way -- exactly the programmatic assertions
# passing and every llm_judge "failing" -- which looks like a catastrophic
# regression and is nothing but an empty wallet.
UNAVAILABLE = re.compile(
    r"session limit|usage limit|rate limit|quota|overloaded|Execution error",
    re.IGNORECASE)


def judge_llm(criteria, blob, model):
    numbered = "\n".join(f"{i + 1}. {c}" for i, c in enumerate(criteria))
    prompt = (
        "You are grading an AI agent's work against criteria. You do not know which "
        "system produced it and must not speculate about that.\n\n"
        f"=== AGENT RESPONSE AND THE FILES IT PRODUCED ===\n{blob[:16000]}\n=== END ===\n\n"
        f"Criteria:\n{numbered}\n\n"
        "For each criterion answer YES or NO. Judge only what the work actually does, "
        "not what it gestures at. Output ONLY a JSON array of strings, e.g. "
        '["YES","NO"]. No other text.'
    )
    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--model", model, "--setting-sources", "",
             "--disable-slash-commands", "--no-session-persistence", "--allowedTools", ""],
            capture_output=True, text=True, timeout=240,
        )
        if UNAVAILABLE.search(result.stdout) or UNAVAILABLE.search(result.stderr):
            raise JudgeUnavailable(result.stdout.strip()[:200] or "judge unavailable")
        match = re.search(r"\[[^\]]*\]", result.stdout, re.S)
        if not match:
            raise JudgeUnavailable(
                f"judge returned no verdict array (exit {result.returncode})")
        verdicts = json.loads(match.group(0))
        if len(verdicts) != len(criteria):
            raise JudgeUnavailable(
                f"judge returned {len(verdicts)} verdicts for {len(criteria)} criteria")
        return verdicts
    except JudgeUnavailable:
        raise
    except Exception as exc:
        raise JudgeUnavailable(str(exc)[:200]) from exc


def main():
    parser = argparse.ArgumentParser(description="Score one self-evolution GT case")
    parser.add_argument("case_id")
    parser.add_argument("run_dir")
    parser.add_argument("--gt", default=os.path.join(SELF_DIR, "gt.json"))
    parser.add_argument("--model", action="append", default=None,
                        help="Judge model. Repeat for a panel; a criterion needs a "
                             "majority of YES to pass, and disagreements are recorded.")
    parser.add_argument("--judge-repeats", type=int, default=3,
                        help="Invocations per judge. The judge is not deterministic: the "
                             "same model on the same transcript was measured flipping a "
                             "criterion roughly one time in four. One invocation per run "
                             "charges that coin-flip to the artifact.")
    args = parser.parse_args()
    models = args.model or ["sonnet"]

    gt = json.load(open(args.gt))
    case = next((c for c in gt["cases"] if c["id"] == args.case_id), None)
    if case is None:
        sys.exit(f"unknown case: {args.case_id}")

    work = args.run_dir
    total = len(case["assertions"])

    # A crashed run carries no behavioural information. Scoring it zero would
    # read as a regression; the suite re-runs these instead.
    if os.path.exists(os.path.join(work, "_crashed.txt")):
        print(json.dumps({"case": args.case_id, "crashed": True,
                          "passed": 0, "total": total, "results": []}))
        return

    blob = produced_blob(work)
    results, criteria = [], []

    for assertion in case["assertions"]:
        kind, value = assertion["type"], assertion.get("value", "")
        if kind == "contains":
            results.append({"type": kind, "value": value, "passed": value in blob})
        elif kind == "not_contains":
            results.append({"type": kind, "value": value, "passed": value not in blob})
        elif kind == "regex":
            results.append({"type": kind, "value": value,
                            "passed": bool(re.search(value, blob, re.S))})
        elif kind == "file_exists":
            # Recursive: the loop writes into <artifact>-evolution/, not cwd.
            found = bool(glob.glob(f"{work}/**/{value}", recursive=True))
            results.append({"type": kind, "value": value, "passed": found})
        elif kind == "script":
            env = dict(os.environ, SKILL_DIR=work)
            try:
                run = subprocess.run(value, shell=True, cwd=work, capture_output=True,
                                     timeout=120, env=env)
                results.append({"type": kind, "value": value, "passed": run.returncode == 0})
            except Exception as exc:
                results.append({"type": kind, "value": value, "passed": False, "error": str(exc)})
        elif kind in ("llm_judge", "fact_coverage"):
            criteria.append(value)

    disagreements = []
    if criteria:
        panel = {}
        for model in models:
            try:
                # Majority over repeated invocations of the same model, so a
                # single flip cannot move the score.
                ballots = [judge_llm(criteria, blob, model)
                           for _ in range(max(1, args.judge_repeats))]
                panel[model] = [
                    "YES" if sum(b[i].strip().upper() == "YES" for b in ballots) * 2
                             > len(ballots) else "NO"
                    for i in range(len(criteria))
                ]
                panel[model + "__ballots"] = ballots
            except JudgeUnavailable as exc:
                # One unreachable judge invalidates the panel. Silently falling
                # back to the survivors changes the oracle mid-measurement.
                print(json.dumps({
                    "case": args.case_id, "crashed": False, "judge_unavailable": True,
                    "error": f"{model}: {exc}", "passed": 0,
                    "total": len(case["assertions"]), "results": [],
                }))
                sys.exit(3)

        for i, criterion in enumerate(criteria):
            votes = {m: panel[m][i].strip().upper() == "YES" for m in models}
            spread = {m: sum(b[i].strip().upper() == "YES" for b in panel[m + "__ballots"])
                      for m in models}
            yes = sum(votes.values())
            passed = yes * 2 > len(models)          # strict majority
            if 0 < yes < len(models):
                disagreements.append({"criterion": criterion, "votes": votes})
            results.append({"type": "llm_judge", "value": criterion,
                            "passed": passed, "votes": votes,
                            "yes_ballots_of_%d" % max(1, args.judge_repeats): spread})

    print(json.dumps({
        "case": args.case_id,
        "crashed": False,
        "judge_unavailable": False,
        "judges": models,
        "judge_repeats": max(1, args.judge_repeats),
        "passed": sum(1 for r in results if r["passed"]),
        "total": len(results),
        "disagreements": disagreements,
        "results": results,
    }))


if __name__ == "__main__":
    main()
