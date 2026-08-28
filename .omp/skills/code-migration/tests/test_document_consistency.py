"""Cross-document consistency of the figures the skill's own documents state.

Seven review rounds closed seven defect classes. The sixth was corrections landing in one
document while the siblings kept contradicting it, and the first version of this file was
written to mechanize it. Round seven found that version had closed the class in one of four
renderings: it matched the literal phrase `N of M assertions`, while three live copies of the
same figure interpose a word (`GT assertions`, `` `llm_judge` ``) or invert the order
(`138 assertions · 136`). Its mutation proofs had all been sampled from inside its own
coverage, so it reported green while three quarters of the population drifted freely.

So this version enumerates the population **by value** rather than by phrasing, and asserts its
own coverage as a test in its own right: every line stating a ground-truth value in a figure
context must be matched by some pattern here. A guard that silently stops matching is the
failure mode being guarded against — and it is the one the previous version had.
"""

from __future__ import annotations

import glob
import json
import re
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
WORKSPACE = SKILL.parent / "code-migration-evolution"

# Lines narrating a superseded figure rather than asserting a current one. `[corrected]` is
# deliberately NOT here: round seven found it marks lines that were just corrected and are now
# authoritative — exempting them excused exactly the lines most needing the check, and a
# mutation to the canonical `1 of 9` derivation passed silently behind it.
HISTORICAL = re.compile(
    r"earlier draft|earlier wording|\brev [12]\b|retract|superseded|was wrong|"
    r"previously|an earlier|had said|withdrawn|used to",
    re.IGNORECASE,
)

FIGURE_CONTEXT = re.compile(r"suites|cases|assertions|prediction", re.IGNORECASE)

# The population is not homogeneous, which enumerating it by value is what revealed: a
# per-suite size ("session-dev.json (11 cases)") and a per-run tally ("116/117 assertions")
# are both correct and neither is the corpus total. Only lines framed as corpus-wide are in
# scope; a line naming one suite file or reporting a run is not.
CORPUS_CONTEXT = re.compile(r"\bsuites\b|corpus|oracle|gt/\*|the GT\b", re.IGNORECASE)
PER_ITEM_CONTEXT = re.compile(
    r"session-\w+\.json|\w+-\w+\.json \(|case-runs|pass_rate|pass@|/\d+ assertions",
    re.IGNORECASE,
)


# `SKILL.md:138` is a line reference, not a claim that something numbers 138. Strip those
# before reading values off a line, or value-triggered scanning flags every cross-reference.
LINE_REFERENCE = re.compile(r"[\w./-]+\.(?:md|py|json|tsv|sh):\d+(?:-\d+)?")


def values_in(line: str) -> set[int]:
    return {int(token) for token in re.findall(r"(?<![\w-])(\d+)", LINE_REFERENCE.sub(" ", line))}


def corpus_line(line: str) -> bool:
    return bool(CORPUS_CONTEXT.search(line)) and not PER_ITEM_CONTEXT.search(line)

DOCUMENTS = ("ARCHITECTURE.md",)
WORKSPACE_DOCUMENTS = (
    "FIRST_PRINCIPLES_AUDIT.md",
    "PHASE2_FINAL_REPORT.md",
    "PHASE3_FINAL_REPORT.md",
    "MECH_ASSERTION_QUALIFICATION.md",
    "FINAL_REPORT.md",
    "evolve_plan.md",
    ".gitignore",
)


def documents() -> list[tuple[str, str]]:
    found = []
    for base, names in ((SKILL, DOCUMENTS), (WORKSPACE, WORKSPACE_DOCUMENTS)):
        for name in names:
            path = base / name
            if path.is_file():
                found.append((name, path.read_text(encoding="utf-8")))
    return found


def current_lines(text: str):
    for number, line in enumerate(text.splitlines(), start=1):
        if not HISTORICAL.search(line):
            yield number, line


def gt_truth() -> dict[str, int]:
    suites = sorted(glob.glob(str(WORKSPACE / "gt" / "*.json")))
    cases = assertions = judged = 0
    for path in suites:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
        for case in document.get("cases", []):
            cases += 1
            for assertion in case.get("assertions", []):
                assertions += 1
                if assertion.get("type") == "llm_judge":
                    judged += 1
    return {"suites": len(suites), "cases": cases, "assertions": assertions, "judged": judged}


APPROVAL_VERSION = re.compile(r"missions[\w.]*\.approval\.v\d+")

# Only the two places the producer can *state* the version: the named constant, and the literal
# at the emit site it replaced. A whole-file scan looked simpler and was wrong — the resolver's
# comment names both generations on purpose to explain why filename-based pairing is unsafe, so
# a bare scan reported two versions and failed on correct code.
PRODUCER_SITES = (
    re.compile(
        r'^APPROVAL_ENVELOPE_SCHEMA_VERSION\s*=\s*"(missions[\w.]*\.approval\.v\d+)"', re.M
    ),
    re.compile(r'"schemaVersion":\s*"(missions[\w.]*\.approval\.v\d+)"'),
)


def producer_approval_version() -> set[str]:
    """The approval-envelope schemaVersion the producer actually emits.

    Read out of the source rather than imported: the version was a bare literal at the emit site
    before the resolver existed, so a check that keyed on the named constant — or skipped when
    it could not find one — would go quiet exactly across the rename it exists to police.
    """
    source = SKILL / "tools" / "build_missions_v4_pack.py"
    if not source.is_file():
        return set()
    text = source.read_text(encoding="utf-8")
    return {match for pattern in PRODUCER_SITES for match in pattern.findall(text)}


def predictions_committed() -> int:
    ledger = WORKSPACE / "predictions.jsonl"
    if not ledger.is_file():
        return 0
    return sum(1 for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip())


NUMBER = r"(?<![\w-])(\d+)"
# Patterns tolerate interposed words on purpose: `136 of 138 GT assertions` and
# ``136 of 138 `llm_judge` assertions`` are the live renderings the previous version missed.
CHECKS = (
    ("suites", re.compile(NUMBER + r"\s+suites"), lambda t: (t["suites"],)),
    ("cases", re.compile(NUMBER + r"\s+cases"), lambda t: (t["cases"],)),
    (
        "judged of total",
        re.compile(NUMBER + r" of " + NUMBER + r"[^.,;]{0,28}assertions"),
        lambda t: (t["judged"], t["assertions"]),
    ),
    (
        "judged of total, no noun",
        re.compile(NUMBER + r" of " + NUMBER + r"\s+[`*]{0,2}llm_judge"),
        lambda t: (t["judged"], t["assertions"]),
    ),
    (
        "bare total",
        re.compile(NUMBER + r"\s+assertions(?![^.]{0,14}\*\*\d)"),
        lambda t: (t["assertions"],),
    ),
    (
        "total then judged",
        re.compile(NUMBER + r"\s+assertions[^.]{0,14}\*\*" + NUMBER),
        lambda t: (t["assertions"], t["judged"]),
    ),
)


class DocumentConsistencyTests(unittest.TestCase):
    def setUp(self) -> None:
        if not WORKSPACE.is_dir():
            self.skipTest(f"evolution workspace absent at {WORKSPACE}")
        self.truth = gt_truth()
        self.documents = documents()
        self.assertTrue(self.documents, "no documents found to check")

    def test_stated_figures_agree_with_primary_data(self) -> None:
        wrong = []
        for name, text in self.documents:
            for number, line in current_lines(text):
                present = values_in(line)
                distinctive = {self.truth["assertions"], self.truth["judged"]}
                if not corpus_line(line) and not (present & distinctive):
                    continue
                for label, pattern, expected in CHECKS:
                    for match in pattern.finditer(line):
                        stated = tuple(int(group) for group in match.groups())
                        if stated != expected(self.truth):
                            wrong.append(
                                f"{name}:{number} states {label}={stated}, "
                                f"actual {expected(self.truth)} — {line.strip()[:70]}"
                            )
        self.assertFalse(wrong, "\n".join(wrong))

    def test_every_figure_bearing_line_is_actually_covered(self) -> None:
        """The population, enumerated by value rather than by phrasing.

        Any line mentioning a figure keyword and carrying a ground-truth value must be matched
        by one of CHECKS. This is what the previous version lacked: its proofs came from inside
        its own coverage, so three of four renderings could drift while every test stayed green.
        """
        values = {
            self.truth["suites"],
            self.truth["cases"],
            self.truth["assertions"],
            self.truth["judged"],
        }
        # 136 and 138 mean one thing in these documents, so a line carrying either is in
        # scope on the strength of the value alone. Requiring a keyword or a corpus phrase
        # first is what let `136 of 138 GT assertions` and ``136 of 138 `llm_judge` `` slip
        # past the previous two versions — the check kept re-acquiring a phrasing dependency.
        distinctive = {self.truth["assertions"], self.truth["judged"]}
        uncovered = []
        for name, text in self.documents:
            for number, line in current_lines(text):
                present = values_in(line)
                if not (present & values):
                    continue
                if not (present & distinctive):
                    if not FIGURE_CONTEXT.search(line) or not corpus_line(line):
                        continue
                # Per clause, not per line. Certifying a line because one of its clauses
                # matched is what let `12 suites, 50 cases, 138 assertions` hide a drifting
                # `138` behind a matching `12` — round eight's class, reproduced by a later
                # mutation sweep. A value is covered only if some pattern consumed that value.
                consumed = {
                    int(group)
                    for _, pattern, _ in CHECKS
                    for match in pattern.finditer(line)
                    for group in match.groups()
                }
                unconsumed = (present & values) - consumed
                if not unconsumed:
                    continue
                uncovered.append(
                    f"{name}:{number} — {sorted(unconsumed)} unmatched in: {line.strip()[:70]}"
                )
        self.assertFalse(
            uncovered,
            "figure-bearing lines carrying a ground-truth value that no pattern matches:\n"
            + "\n".join(uncovered),
        )

    def test_scaffolding_headers_match_the_contract_that_documents_them(self) -> None:
        """A template that half-encodes a contract is a sibling that can drift.

        `references/artifacts.md` declares the gap-inventory column contract and
        `templates/gap-inventory.tsv` ships a header row with the same nine names. Nothing
        compared them, and the documents checker above scans no templates — so this is the
        round-six class (a correction landing in one copy) still live in the file that fixed it.
        """
        template = SKILL / "templates" / "gap-inventory.tsv"
        contract = SKILL / "references" / "artifacts.md"
        if not (template.is_file() and contract.is_file()):
            self.skipTest("gap-inventory template or its contract is absent")
        header = template.read_text(encoding="utf-8").splitlines()[0].split("\t")
        declared = re.search(
            r"header exactly:\s*\n`([^`]+)`", contract.read_text(encoding="utf-8")
        )
        self.assertIsNotNone(declared, "artifacts.md no longer declares the header")
        self.assertEqual(
            declared.group(1).split(),
            header,
            "templates/gap-inventory.tsv and references/artifacts.md disagree on the columns",
        )

    def test_prediction_denominator_agrees_with_the_ledger(self) -> None:
        committed = predictions_committed()
        if not committed:
            self.skipTest("predictions.jsonl absent")
        pattern = re.compile(r"\b1 of (?P<value>\d+)\b")
        wrong = []
        for name, text in self.documents:
            recent: list[str] = []
            for number, line in current_lines(text):
                recent = (recent + [line])[-3:]
                context = " ".join(recent).lower()
                # Only the phase-spanning figure carries the ledger's denominator; a
                # phase-scoped one ("1 of 4" for phase 2 alone) is a different count.
                if "prediction" not in context:
                    continue
                if not ("across phases" in context or "phases 2" in context):
                    continue
                for match in pattern.finditer(line):
                    stated = int(match.group("value"))
                    if stated != committed:
                        wrong.append(
                            f"{name}:{number} states 1 of {stated}, ledger holds {committed}"
                        )
        self.assertFalse(wrong, "\n".join(wrong))

    def test_the_checker_scans_a_real_population(self) -> None:
        # Every declared document must actually have been read. `documents()` skips what it
        # cannot find, so renaming or deleting one would otherwise shrink the population and
        # leave this suite green — the silent degradation this file exists to prevent, in the
        # file itself. A count floor cannot catch that; naming the absentees can.
        names = {name for name, _ in self.documents}
        declared = set(DOCUMENTS) | set(WORKSPACE_DOCUMENTS)
        self.assertEqual(
            set(), declared - names, f"declared documents that were not read: {declared - names}"
        )
        matched = sum(
            1
            for _, text in self.documents
            for _, line in current_lines(text)
            if corpus_line(line)
            for _, pattern, _ in CHECKS
            if pattern.search(line)
        )
        # Existence is not coverage — that was the previous guard's flaw, and the coverage test
        # above is the real answer — but a floor still catches a regex edit that silently stops
        # matching everything.
        self.assertGreaterEqual(matched, 6, f"only {matched} figure statements matched")


class ProducerVersionStringTests(unittest.TestCase):
    """Documents that quote a version string the code emits must quote the current one.

    This is the round-six class again, but across the prose/code boundary rather than between
    two documents, and nothing was watching it: when Missions dropped the `v4` generation,
    `SKILL.md` and `references/delegation.md` went on naming `missions.v4.approval.v1` — a
    string the producer no longer emits — and every test stayed green.
    """

    def test_docs_quote_the_approval_version_the_producer_emits(self) -> None:
        emitted = producer_approval_version()
        self.assertEqual(
            1,
            len(emitted),
            f"producer must name exactly one approval schemaVersion, found {sorted(emitted)}",
        )
        current = emitted.pop()
        wrong = []
        for path in [SKILL / "SKILL.md", *sorted((SKILL / "references").glob("*.md"))]:
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for stated in APPROVAL_VERSION.findall(line):
                    if stated != current:
                        wrong.append(f"{path.name}:{number} states {stated}, producer emits {current}")
        self.assertFalse(wrong, "\n".join(wrong))


if __name__ == "__main__":
    unittest.main()
