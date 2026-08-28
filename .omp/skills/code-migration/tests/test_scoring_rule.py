"""The oracle's scoring rule — `code-migration-evolution/phase2/aggregate.py`.

Every verdict in three evolution phases came out of this rule, and until now nothing checked
it. It was two inline heredocs before, equally untested, and consolidating them into one owner
was the moment to fix that rather than the moment to notice it.

The refusal is the part that matters. A crashed or unjudged case carries no behavioural
information, so a partial suite must publish `pass_rate: null` and exit 4 rather than scoring
the survivors — a quota outage that scored as a regression corrupted a whole run once already.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
AGGREGATE = SKILL.parent / "code-migration-evolution" / "phase2" / "aggregate.py"


def write_case_gt(directory: Path, case_ids: list[str]) -> Path:
    path = directory / "gt.json"
    path.write_text(
        json.dumps({"cases": [{"id": case_id, "assertions": []} for case_id in case_ids]}),
        encoding="utf-8",
    )
    return path


def write_verdict(out: Path, case_id: str, **fields) -> None:
    judge = out / "judge"
    judge.mkdir(parents=True, exist_ok=True)
    document = {"case": case_id, "passed": 0, "total": 0, **fields}
    (judge / f"{case_id}.json").write_text(json.dumps(document), encoding="utf-8")


@unittest.skipUnless(AGGREGATE.is_file(), f"scoring rule absent at {AGGREGATE}")
class ScoringRuleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.out = self.root / "out"
        self.out.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_aggregate(self, gt: Path, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(AGGREGATE), str(gt), str(self.out), *extra],
            capture_output=True, text=True,
        )

    def results(self) -> dict:
        return json.loads((self.out / "l2_results.json").read_text(encoding="utf-8"))

    def test_scores_a_complete_suite(self) -> None:
        gt = write_case_gt(self.root, ["a", "b"])
        write_verdict(self.out, "a", passed=2, total=2)
        write_verdict(self.out, "b", passed=1, total=2)
        result = self.run_aggregate(gt)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(0.5, self.results()["pass_rate"])

    def test_refuses_to_score_a_suite_with_a_crashed_case(self) -> None:
        gt = write_case_gt(self.root, ["a", "b"])
        write_verdict(self.out, "a", passed=2, total=2)
        write_verdict(self.out, "b", crashed=True)
        result = self.run_aggregate(gt)
        self.assertEqual(4, result.returncode, result.stdout + result.stderr)
        self.assertIsNone(self.results()["pass_rate"])

    def test_refuses_to_score_a_suite_with_an_unavailable_judge(self) -> None:
        # This is the quota-outage case: the executor produced work, the judge could not be
        # reached, and scoring the survivors would report a regression that never happened.
        gt = write_case_gt(self.root, ["a", "b"])
        write_verdict(self.out, "a", passed=2, total=2)
        write_verdict(self.out, "b", judge_unavailable=True)
        result = self.run_aggregate(gt)
        self.assertEqual(4, result.returncode)
        self.assertIsNone(self.results()["pass_rate"])
        self.assertIn("judge unavailable", json.dumps(self.results()["incomplete"]))

    def test_refuses_to_score_a_suite_with_a_missing_verdict(self) -> None:
        gt = write_case_gt(self.root, ["a", "b"])
        write_verdict(self.out, "a", passed=2, total=2)
        result = self.run_aggregate(gt)
        self.assertEqual(4, result.returncode)
        self.assertIsNone(self.results()["pass_rate"])

    def test_crash_label_and_skill_key_follow_the_caller(self) -> None:
        # run_suite retries a crash once, so it reports "crashed twice"; rejudge does not retry
        # and reports "crashed". Only run_suite records the skill under test.
        gt = write_case_gt(self.root, ["a"])
        write_verdict(self.out, "a", crashed=True)
        self.run_aggregate(gt, "--skill", "/somewhere", "--crash-label", "crashed twice")
        recorded = self.results()
        self.assertEqual("/somewhere", recorded["skill"])
        self.assertEqual("crashed twice", recorded["incomplete"]["a"])

        self.run_aggregate(gt)
        recorded = self.results()
        self.assertNotIn("skill", recorded)
        self.assertEqual("crashed", recorded["incomplete"]["a"])

    def test_a_bad_invocation_does_not_report_success(self) -> None:
        # argparse would have turned `-h` into a usage message and exit 0, i.e. a run that
        # scored nothing and said it worked. The heredocs this replaced exited non-zero.
        result = subprocess.run(
            [sys.executable, str(AGGREGATE), "-h", str(self.out)], capture_output=True, text=True
        )
        self.assertNotEqual(0, result.returncode)
        self.assertFalse((self.out / "l2_results.json").exists())


if __name__ == "__main__":
    unittest.main()
