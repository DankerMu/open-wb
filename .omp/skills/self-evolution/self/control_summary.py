#!/usr/bin/env python3
"""Summarize a control-arm run into pass@1 and pass@K.

    ./self/control_summary.py <control-out-dir> --k <K> [--baseline <dir>]
                              [--evolved <l2_results.json> ...]

Writes <control-out-dir>/control_arm.json. When one or more evolved
l2_results.json files are supplied, also prints the verdict table and the
CONFIRMED / UNCONFIRMED / REFUTED / ENSEMBLE EFFECT call from budget-parity.md.
"""

import argparse
import glob
import hashlib
import json
import os

SELF_DIR = os.path.dirname(os.path.abspath(__file__))

SIGNIFICANCE = 0.02  # matches the gate's noise threshold


def load_samples(out_dir, k):
    """per_case[case_id] -> list of (passed, total) per sample that scored."""
    per_case, missing = {}, []
    for sample in range(1, k + 1):
        judge_dir = os.path.join(out_dir, f"sample-{sample}", "judge")
        for path in sorted(glob.glob(os.path.join(judge_dir, "*.json"))):
            try:
                entry = json.load(open(path))
            except (OSError, json.JSONDecodeError):
                continue
            if entry.get("crashed") or entry.get("judge_unavailable"):
                missing.append(f"sample-{sample}/{entry.get('case', '?')}")
                continue
            per_case.setdefault(entry["case"], []).append(
                (entry["passed"], entry["total"]))
    return per_case, missing


def main():
    parser = argparse.ArgumentParser(description="Summarize a budget-matched control arm")
    parser.add_argument("out_dir")
    parser.add_argument("--k", type=int, required=True)
    parser.add_argument("--baseline", default="")
    parser.add_argument("--evolved", nargs="*", default=[],
                        help="l2_results.json of the evolved artifact, one per repeat")
    args = parser.parse_args()

    per_case, missing = load_samples(args.out_dir, args.k)
    if not per_case:
        raise SystemExit("no scored samples found")

    expected_cases = len(json.load(open(os.path.join(SELF_DIR, "gt.json")))["cases"])
    absent = expected_cases - len(per_case)
    short = {c: len(v) for c, v in per_case.items() if len(v) < args.k}

    # pass@1: expected score of one sample drawn at random.
    # pass@K per protocol (control_arm.sh, budget-parity.md): "any sample
    # scored full marks" — a case passes when at least one of its K samples is
    # perfect. Oracle selection is required, so it is an upper bound.
    #
    # Two units are reported because the evolved side's dev_pass_rate is an
    # assertion-weighted proportion while the per-case mean weights every case
    # equally (measured: the two disagree by up to 0.06). Comparing them
    # directly mixes units, so the verdict is taken from the assertion-level
    # column, which is the unit dev_pass_rate is defined in; the case-level
    # column is reported as a sensitivity check.
    def _mean(xs):
        xs = list(xs)
        return sum(xs) / len(xs)

    def _rate(p, t):
        return p / t if t else 0.0  # an unscored sample scores zero, as before

    case_pass1 = _mean(_mean(_rate(p, t) for p, t in v) for v in per_case.values())
    assert_pass1 = (sum(p for v in per_case.values() for p, t in v)
                    / sum(t for v in per_case.values() for p, t in v))
    case_passk = _mean(
        1.0 if any(_rate(p, t) >= 1.0 for p, t in v) else 0.0
        for v in per_case.values())
    pass1, passk = case_pass1, case_passk  # backwards-compatible field names

    # An arm missing whole cases is not a weaker arm, it is a different one, and
    # comparing it to a full evolved run flatters whichever side lost less data.
    complete = not absent and not missing and not short
    if not complete:
        print("INCOMPLETE CONTROL ARM — no verdict can be drawn.")
        if absent:
            print(f"  {absent} of {expected_cases} cases have no scored sample at all")
        if short:
            print(f"  {len(short)} case(s) scored on fewer than K={args.k} samples: {short}")
        if missing:
            print(f"  {len(missing)} sample(s) crashed or went unjudged")
        print(f"  partial pass@1 over {len(per_case)} cases would be {pass1:.4f} — "
              f"NOT comparable to a full run.")

    result = {
        "complete": complete,
        "cases_expected": expected_cases,
        "cases_absent": absent,
        "arm": "parallel_sampling",
        "baseline": args.baseline,
        "K": args.k,
        "cases": len(per_case),
        "pass_at_1": round(case_pass1, 4),
        "pass_at_1_assertion_level": round(assert_pass1, 4),
        "pass_at_k": round(case_passk, 4),
        "samples_missing": missing,
        "cases_with_fewer_than_k_samples": short,
        "per_case": {c: [round(_rate(p, t), 4) for p, t in v] for c, v in sorted(per_case.items())},
    }

    # Reproducibility: which repeats went into the verdict, and the GT the arm
    # was judged against. Without the inputs, a verdict like 0.8823 is not
    # auditable — the evolved side can be one repeat or three and the number is
    # the same shape. Hash the GT so a judge-criteria change between arms
    # (measured on this skill: case-06 criteria differed) is visible instead of
    # silently biasing one side.
    result["evolved_inputs"] = list(args.evolved)
    result["gt_sha256"] = hashlib.sha256(
        open(os.path.join(SELF_DIR, "gt.json"), "rb").read()).hexdigest()[:16]

    out_path = os.path.join(args.out_dir, "control_arm.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    print(f"control arm (parallel sampling, K={args.k}, {len(per_case)} cases)")
    print(f"  pass@1: {pass1:.4f}")
    print(f"  pass@K: {passk:.4f}")
    print(f"written: {out_path}")

    if not complete:
        raise SystemExit(4)

    if not args.evolved:
        print("\nNo --evolved supplied, so no verdict. The arm alone is not a conclusion.")
        return

    rates_assert, rates_case, rates_binary = [], [], []
    for path in args.evolved:
        data = json.load(open(path))
        if data.get("complete"):
            # dev_pass_rate is assertion-weighted; mean per-case pass_rate is
            # the case-level unit. Both go into the comparison so the verdict
            # cannot be an artifact of the unit choice. The binary full-marks
            # rate matches the arm's pass@K unit ("any sample scored full
            # marks") — comparing a score to a full-marks rate mixes units.
            rates_assert.append(data["dev_pass_rate"])
            cases = data.get("cases", [])
            rates_case.append(sum(c["pass_rate"] for c in cases) / len(cases))
            rates_binary.append(
                sum(1.0 for c in cases if c["passed"] == c["total"]) / len(cases))
    if not rates_assert:
        raise SystemExit("no complete evolved results supplied")
    evolved_assert = sum(rates_assert) / len(rates_assert)
    evolved_case = sum(rates_case) / len(rates_case)
    evolved_binary = sum(rates_binary) / len(rates_binary)
    result["evolved_repeat_rates"] = [round(r, 4) for r in rates_assert]
    result["evolved_repeat_case_rates"] = [round(r, 4) for r in rates_case]
    result["evolved_repeat_full_marks_rates"] = [round(r, 4) for r in rates_binary]
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    print(f"\n{'':<24}{'pass@1':<12}{'pass@1':<12}{'pass@K*':<12}full-marks")
    print(f"{'':<24}{'(case)':<12}{'(assertion)':<12}{'':<12}(single run)")
    print(f"{'evolved artifact':<24}{evolved_case:<12.4f}{evolved_assert:<12.4f}{'—':<12}{evolved_binary:.4f}")
    print(f"{'baseline, parallel':<24}{case_pass1:<12.4f}{assert_pass1:<12.4f}{case_passk:<12.4f}—")
    print("  * pass@K = any of the K samples scored full marks (protocol; only the")
    print("    baseline has K samples — the evolved side ran once, so its full-marks")
    print("    rate is a single-run number, not a pass@K.)")

    # Verdict on the assertion-level unit (the unit dev_pass_rate is defined
    # in); the case-level delta is reported as a sensitivity check, and a
    # verdict that differs between the two units is not clean.
    delta_assert = evolved_assert - assert_pass1
    delta_case = evolved_case - case_pass1
    if delta_assert > SIGNIFICANCE and delta_case > SIGNIFICANCE:
        verdict = "CONFIRMED"
        gloss = "the artifact is genuinely better at matched budget"
    elif delta_assert < -SIGNIFICANCE and delta_case < -SIGNIFICANCE:
        verdict = "REFUTED"
        gloss = "an equal-budget baseline strategy beats the evolved artifact"
    else:
        verdict = "UNCONFIRMED"
        gloss = "the gain is not separable from spending the budget on sampling"
    # pass@K is the protocol's binary full-marks rate; the evolved side's
    # binary full-marks rate is its same-unit counterpart. ENSEMBLE EFFECT
    # needs pass@K to beat it once the pass@1 deltas are both flat.
    if abs(delta_assert) <= SIGNIFICANCE and abs(delta_case) <= SIGNIFICANCE \
            and case_passk > evolved_binary + SIGNIFICANCE:
        verdict = "ENSEMBLE EFFECT"
        gloss = "extra attempts helped; the artifact itself did not improve"
    if (delta_assert > SIGNIFICANCE) != (delta_case > SIGNIFICANCE):
        gloss += " (disagrees with the case-level unit: " + \
            f"assertion {delta_assert:+.4f} vs case {delta_case:+.4f})"

    print(f"\nVERDICT: {verdict} — {gloss}")
    print(f"  evolved {evolved_assert:.4f} vs control pass@1 (assertion) {assert_pass1:.4f}  "
          f"(delta {delta_assert:+.4f}, significance {SIGNIFICANCE})")

    result["verdict"] = verdict
    result["evolved_pass_at_1"] = round(evolved_assert, 4)
    result["evolved_pass_at_1_case_level"] = round(evolved_case, 4)
    result["evolved_full_marks_rate"] = round(evolved_binary, 4)
    result["delta"] = round(delta_assert, 4)
    result["delta_case_level"] = round(delta_case, 4)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)


if __name__ == "__main__":
    main()
