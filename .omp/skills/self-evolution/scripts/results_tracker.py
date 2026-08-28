#!/usr/bin/env python3
"""Track evolution results in TSV and JSONL formats.

Usage:
    python results_tracker.py <workspace> init
    python results_tracker.py <workspace> init --mode scoreboard

    python results_tracker.py <workspace> log \
        --iteration 5 --layer 2 --mutation-type "disambiguation" \
        --description "Added hint for ambiguous queries" \
        --pass-rate 0.86 --delta 0.04 --decision KEEP \
        --tokens 12400 --duration 91.3

    python results_tracker.py <workspace> log --mode scoreboard \
        --iteration 0 --layer 0 --mutation-type "baseline" \
        --description "Baseline run" \
        --metric-name val_bpb --metric-value 1.0000 --metric-direction minimize \
        --delta 0.0 --decision BASELINE

    python results_tracker.py <workspace> log --mode scoreboard \
        --iteration 5 --layer 2 --mutation-type "optimizer-change" \
        --description "Changed optimizer schedule" \
        --metric-name val_bpb --metric-value 0.9975 --metric-direction minimize \
        --delta -0.0025 --decision KEEP --duration 91.3

    python results_tracker.py <workspace> log --mode pairwise \
        --iteration 3 --layer 1 --mutation-type "contract-tightening" \
        --description "Narrowed planner->writer handoff to the outline only" \
        --win-rate 0.7 --delta 0.2 --decision KEEP

    python results_tracker.py <workspace> budget
    python results_tracker.py <workspace> budget --total-oracle-runs 400 --set-size 20
    python results_tracker.py <workspace> summary
    python results_tracker.py <workspace> best
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone


COST_COLUMNS = "oracle_runs\ttokens\tduration_s\tcost_usd"
GT_TSV_HEADER = f"iteration\tlayer\tmutation_type\tdescription\tpass_rate\tdelta\tdecision\t{COST_COLUMNS}\ttimestamp\n"
SCOREBOARD_TSV_HEADER = f"iteration\tlayer\tmutation_type\tdescription\tmetric_name\tmetric_value\tmetric_direction\tdelta\tdecision\t{COST_COLUMNS}\ttimestamp\n"
PAIRWISE_TSV_HEADER = f"iteration\tlayer\tmutation_type\tdescription\twin_rate\tdelta\tdecision\t{COST_COLUMNS}\ttimestamp\n"

TSV_HEADERS = {
    "gt": GT_TSV_HEADER,
    "scoreboard": SCOREBOARD_TSV_HEADER,
    "pairwise": PAIRWISE_TSV_HEADER,
}

MODES = ("gt", "scoreboard", "pairwise")
DECISIONS = ("BASELINE", "KEEP", "DISCARD", "ROLLBACK", "CONTROL")

# Decisions that represent a surviving artifact state. CONTROL rows measure a
# baseline strategy rather than a mutation, and ROLLBACK rows were undone by a
# blocking gate, so neither can be the best-so-far.
BEST_ELIGIBLE = {"KEEP", "BASELINE"}


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(2)


def format_float(value):
    return f"{value:.10g}"


def tsv_cell(value):
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def init_workspace(workspace, mode="gt"):
    os.makedirs(workspace, exist_ok=True)
    if mode != "scoreboard":
        os.makedirs(os.path.join(workspace, "gt"), exist_ok=True)
    os.makedirs(os.path.join(workspace, "traces"), exist_ok=True)
    os.makedirs(os.path.join(workspace, "iterations"), exist_ok=True)

    tsv_path = os.path.join(workspace, "results.tsv")
    if not os.path.exists(tsv_path):
        with open(tsv_path, "w") as f:
            f.write(TSV_HEADERS[mode])

    jsonl_path = os.path.join(workspace, "experiments.jsonl")
    if not os.path.exists(jsonl_path):
        open(jsonl_path, "w").close()

    if mode == "pairwise":
        history_path = os.path.join(workspace, "preference_history.jsonl")
        if not os.path.exists(history_path):
            open(history_path, "w").close()

    print(f"Workspace initialized: {workspace} (mode={mode})")


def predictions_path(workspace):
    return os.path.join(workspace, "predictions.jsonl")


def record_prediction(workspace, args):
    """Commit a falsifiable prediction at Phase 2, before the artifact changes.

    A prediction written at Phase 7 sits next to the outcome it is supposed to
    be tested against, and nothing stops it being phrased to match. Committing
    it here — before Phase 3 edits anything and before any result exists — is
    what makes it falsifiable rather than decorative.
    """
    path = predictions_path(workspace)
    existing = read_prediction(workspace, args.iteration)
    if existing is not None:
        fail(f"iteration {args.iteration} already has a committed prediction: "
             f"{existing['predicted_effect']!r}. Predictions are immutable once "
             f"written; use a new iteration number.")

    entry = {
        "iteration": args.iteration,
        "predicted_effect": args.predicted_effect,
        "mutation_family": args.mutation_family,
        "target_cases": args.target_cases.split(",") if args.target_cases else [],
        "committed_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(path, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"Prediction committed for iteration {args.iteration} (before evidence): "
          f"{args.predicted_effect}")


def read_prediction(workspace, iteration):
    path = predictions_path(workspace)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            if entry.get("iteration") == iteration:
                return entry
    return None


def warn_on_header_mismatch(tsv_path, mode):
    """Warn when appending wide rows to a workspace created before the cost columns.

    Workspaces created by an earlier version carry a header without
    oracle_runs/cost_usd. Rows written now have more fields than that header
    names, so the TSV reads misaligned in a spreadsheet. Nothing downstream
    breaks — summary, best, and budget all read experiments.jsonl — so this
    warns rather than refusing, and says exactly how to fix it.
    """
    if not os.path.exists(tsv_path):
        return
    try:
        with open(tsv_path) as f:
            header = f.readline()
    except OSError:
        return
    if not header.strip():
        return

    expected = len(TSV_HEADERS[mode].rstrip("\n").split("\t"))
    actual = len(header.rstrip("\n").split("\t"))
    if actual != expected:
        print(
            f"warning: {tsv_path} has a {actual}-column header but this row has "
            f"{expected} columns (workspace predates the cost columns).\n"
            f"         experiments.jsonl is unaffected; summary/best/budget read from it.\n"
            f"         To realign the TSV header, replace its first line with:\n"
            f"         {TSV_HEADERS[mode].rstrip()}",
            file=sys.stderr,
        )


def log_result(workspace, args):
    timestamp = datetime.now(timezone.utc).isoformat()

    experiment = {
        "iteration": args.iteration,
        "layer": args.layer,
        "mutation_type": args.mutation_type,
        "description": args.description,
        "delta": args.delta,
        "decision": args.decision,
        "oracle_runs": args.oracle_runs,
        "tokens": args.tokens,
        "duration_seconds": args.duration,
        "cost_usd": args.cost_usd,
        "timestamp": timestamp,
    }

    if args.mutation_family:
        experiment["mutation_family"] = args.mutation_family

    # The prediction is sourced from predictions.jsonl, not from this call, so
    # the text scored here is provably the text committed before the evidence
    # existed. A --predicted-effect passed now can only be a mismatch to report.
    committed = read_prediction(workspace, args.iteration)
    if committed:
        experiment["predicted_effect"] = committed["predicted_effect"]
        experiment["prediction_committed_at"] = committed["committed_at"]
        if not experiment.get("mutation_family") and committed.get("mutation_family"):
            experiment["mutation_family"] = committed["mutation_family"]
        if args.predicted_effect and args.predicted_effect != committed["predicted_effect"]:
            print(f"warning: --predicted-effect differs from the prediction committed "
                  f"at Phase 2 for iteration {args.iteration}. Scoring the committed one.\n"
                  f"         committed: {committed['predicted_effect']}\n"
                  f"         passed now: {args.predicted_effect}", file=sys.stderr)
    elif args.predicted_effect:
        experiment["predicted_effect"] = args.predicted_effect
        experiment["prediction_uncommitted"] = True
        print(f"warning: no prediction was committed for iteration {args.iteration} before "
              f"the run. Recording it, but it was written alongside the outcome and is not "
              f"falsifiable evidence. Use `predict` at Phase 2.", file=sys.stderr)

    if args.prediction_correct is not None:
        experiment["prediction_correct"] = args.prediction_correct

    cost_cells = f"{args.oracle_runs}\t{args.tokens}\t{args.duration:.1f}\t{args.cost_usd:.4f}"

    if args.mode == "scoreboard":
        if args.metric_name is None:
            fail("--metric-name is required in scoreboard mode")
        if args.metric_value is None:
            fail("--metric-value is required in scoreboard mode")
        if args.metric_direction is None:
            fail("--metric-direction is required in scoreboard mode")

        tsv_line = (
            f"{args.iteration}\t{args.layer}\t{tsv_cell(args.mutation_type)}\t"
            f"{tsv_cell(args.description)}\t{tsv_cell(args.metric_name)}\t{format_float(args.metric_value)}\t"
            f"{args.metric_direction}\t{args.delta:+.4f}\t{args.decision}\t"
            f"{cost_cells}\t{timestamp}\n"
        )
        experiment.update({
            "metric_name": args.metric_name,
            "metric_value": args.metric_value,
            "metric_direction": args.metric_direction,
        })
        status_text = f"{args.metric_name}={format_float(args.metric_value)}, delta={args.delta:+.4f}"
    elif args.mode == "pairwise":
        if args.win_rate is None:
            fail("--win-rate is required in pairwise mode")

        tsv_line = (
            f"{args.iteration}\t{args.layer}\t{tsv_cell(args.mutation_type)}\t"
            f"{tsv_cell(args.description)}\t{args.win_rate:.4f}\t{args.delta:+.4f}\t"
            f"{args.decision}\t{cost_cells}\t{timestamp}\n"
        )
        experiment["win_rate"] = args.win_rate
        status_text = f"win_rate={args.win_rate:.4f}, delta={args.delta:+.4f}"
    else:
        if args.pass_rate is None:
            fail("--pass-rate is required in gt mode")

        tsv_line = (
            f"{args.iteration}\t{args.layer}\t{tsv_cell(args.mutation_type)}\t"
            f"{tsv_cell(args.description)}\t{args.pass_rate:.4f}\t{args.delta:+.4f}\t"
            f"{args.decision}\t{cost_cells}\t{timestamp}\n"
        )
        experiment["pass_rate"] = args.pass_rate
        status_text = f"pass_rate={args.pass_rate:.4f}, delta={args.delta:+.4f}"

    tsv_path = os.path.join(workspace, "results.tsv")
    warn_on_header_mismatch(tsv_path, args.mode)
    with open(tsv_path, "a") as f:
        f.write(tsv_line)

    if args.gate_details:
        try:
            experiment["gate_details"] = json.loads(args.gate_details)
        except json.JSONDecodeError:
            experiment["gate_details_raw"] = args.gate_details

    if args.target_cases:
        experiment["target_cases"] = args.target_cases.split(",")

    if args.regressions:
        experiment["regressions"] = args.regressions.split(",")
    else:
        experiment["regressions"] = []

    jsonl_path = os.path.join(workspace, "experiments.jsonl")
    with open(jsonl_path, "a") as f:
        f.write(json.dumps(experiment, ensure_ascii=False) + "\n")

    print(f"Logged iteration {args.iteration}: {args.decision} ({status_text})")


def is_scoreboard_entry(exp):
    return "metric_value" in exp or "metric_after" in exp


def parse_metric_value(value):
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        if "/" in value:
            numerator, denominator = value.split("/", 1)
            try:
                return float(numerator) / float(denominator)
            except ValueError:
                return None
        try:
            return float(value)
        except ValueError:
            return None
    return None


def comparable_metric(exp):
    if "metric_value" in exp:
        value = parse_metric_value(exp["metric_value"])
        if value is not None:
            return value, exp.get("metric_direction", "maximize")
    if "pass_rate" in exp:
        return float(exp["pass_rate"]), "maximize"
    if "win_rate" in exp:
        return float(exp["win_rate"]), "maximize"
    if "metric_after" in exp:
        value = parse_metric_value(exp["metric_after"])
        if value is not None:
            return value, exp.get("metric_direction", "maximize")
    return None


def is_better(candidate, incumbent):
    candidate_metric = comparable_metric(candidate)
    if candidate_metric is None:
        return False
    if incumbent is None:
        return True
    incumbent_metric = comparable_metric(incumbent)
    if incumbent_metric is None:
        return True

    candidate_value, direction = candidate_metric
    incumbent_value, _ = incumbent_metric
    if direction == "minimize":
        return candidate_value < incumbent_value
    return candidate_value > incumbent_value


def best_kept_experiment(experiments):
    best = None
    for exp in experiments:
        if exp["decision"] in BEST_ELIGIBLE and is_better(exp, best):
            best = exp
    return best


def load_experiments(workspace, required=True):
    jsonl_path = os.path.join(workspace, "experiments.jsonl")
    if not os.path.exists(jsonl_path):
        if required:
            return None
        return []

    experiments = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if line:
                experiments.append(json.loads(line))
    return experiments


def format_metric(exp):
    metric = comparable_metric(exp)
    if metric is None:
        return "unscored"
    value, direction = metric
    if "metric_name" in exp:
        return f"{exp['metric_name']}: {format_float(value)} ({direction})"
    if "metric_after" in exp:
        return f"metric_after: {format_float(value)} ({direction})"
    return f"pass_rate: {value:.4f}"


def show_budget(workspace, total_oracle_runs=None, set_size=None):
    """Report cumulative spend and the control-arm K the ledger implies.

    Control-arm rows are excluded from the spend total: the arm is what the
    budget is being measured against, so counting it would inflate the very
    number it is compared to.
    """
    experiments = load_experiments(workspace)
    if experiments is None:
        fail(f"No experiments.jsonl in {workspace}")

    spend = [e for e in experiments if e.get("decision") != "CONTROL"]
    control = [e for e in experiments if e.get("decision") == "CONTROL"]

    oracle_runs = sum(int(e.get("oracle_runs") or 0) for e in spend)
    tokens = sum(int(e.get("tokens") or 0) for e in spend)
    duration = sum(float(e.get("duration_seconds") or 0.0) for e in spend)
    cost = sum(float(e.get("cost_usd") or 0.0) for e in spend)

    print(f"Iterations counted: {len(spend)} (excluding {len(control)} control-arm rows)")
    print(f"Oracle runs:   {oracle_runs}")
    print(f"Tokens:        {tokens}")
    print(f"Duration:      {duration:.1f}s ({duration / 3600:.2f}h)")
    print(f"Cost:          ${cost:.4f}")

    if oracle_runs == 0:
        print("\nWARNING: zero oracle runs recorded. Budget parity cannot be checked,")
        print("so no improvement from this run can be confirmed. Pass --oracle-runs when logging.")

    if total_oracle_runs is not None:
        remaining = total_oracle_runs - oracle_runs
        pct = 100.0 * oracle_runs / total_oracle_runs if total_oracle_runs else 0.0
        print(f"\nCeiling:       {total_oracle_runs} oracle runs")
        print(f"Spent:         {pct:.1f}%")
        print(f"Remaining:     {remaining}")
        if remaining <= 0:
            print("STOP: total budget exhausted. Phase 8 must stop the loop.")

    if set_size:
        if set_size <= 0:
            fail("--set-size must be positive")
        k = max(1, math.ceil(oracle_runs / set_size))
        print(f"\nControl arm on a {set_size}-case set: K = {k} attempts per case")
        print(f"Full control arm cost: {k * set_size} oracle runs")
        if k > 5:
            print(f"Capping to K=5 is permitted; report the cap. See references/budget-parity.md")


def show_summary(workspace):
    experiments = load_experiments(workspace)
    if not experiments:
        print("No experiments found.")
        return

    counts = {d: 0 for d in DECISIONS}
    for e in experiments:
        decision = e.get("decision")
        if decision in counts:
            counts[decision] += 1

    best = best_kept_experiment(experiments)
    latest = experiments[-1]

    print(f"Total ledger entries: {len(experiments)}")
    print(f"Baseline: {counts['BASELINE']}")
    print(f"Kept: {counts['KEEP']}, Discarded: {counts['DISCARD']}, "
          f"Rolled back: {counts['ROLLBACK']}, Control: {counts['CONTROL']}")
    if best:
        print(f"Best {format_metric(best)} (iteration {best['iteration']})")
    print(f"Latest {format_metric(latest)} (iteration {latest['iteration']})")

    by_layer = {}
    for e in experiments:
        if e.get("decision") == "CONTROL":
            continue
        layer = e.get("layer", "unknown")
        stats = by_layer.setdefault(layer, {"baseline": 0, "kept": 0, "discarded": 0, "rolled_back": 0})
        decision = e.get("decision")
        if decision == "BASELINE":
            stats["baseline"] += 1
        elif decision == "KEEP":
            stats["kept"] += 1
        elif decision == "ROLLBACK":
            stats["rolled_back"] += 1
        else:
            stats["discarded"] += 1

    print("\nPer-layer breakdown:")
    for layer in sorted(by_layer, key=str):
        s = by_layer[layer]
        print(f"  Layer {layer}: {s['baseline']} baseline, {s['kept']} kept, "
              f"{s['discarded']} discarded, {s['rolled_back']} rolled back")

    scored = [e for e in experiments if "prediction_correct" in e]
    if scored:
        by_family = {}
        for e in scored:
            family = e.get("mutation_family") or e.get("mutation_type", "unknown")
            stats = by_family.setdefault(family, {"scored": 0, "correct": 0, "kept": 0})
            stats["scored"] += 1
            if e["prediction_correct"]:
                stats["correct"] += 1
            if e.get("decision") == "KEEP":
                stats["kept"] += 1

        print("\nPrediction accuracy by mutation family:")
        for family in sorted(by_family):
            s = by_family[family]
            rate = 100.0 * s["correct"] / s["scored"]
            flag = ""
            if s["kept"] > 0 and rate < 50.0:
                flag = "  <-- kept often, predicted poorly; check why these pass"
            print(f"  {family}: {s['correct']}/{s['scored']} correct ({rate:.0f}%), {s['kept']} kept{flag}")
    else:
        print("\nNo scored predictions yet. Pass --predicted-effect and --prediction-correct when logging.")


def show_best(workspace):
    experiments = load_experiments(workspace)
    if experiments is None:
        print(json.dumps({"error": "No experiments found"}))
        sys.exit(1)

    best = best_kept_experiment(experiments)

    if best:
        print(json.dumps(best, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({"error": "No kept iterations found"}))
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Evolution results tracker")
    parser.add_argument("workspace", help="Path to evolution workspace")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Initialize workspace")
    init_parser.add_argument("--mode", choices=MODES, default="gt")

    log_parser = subparsers.add_parser("log", help="Log an iteration result")
    log_parser.add_argument("--mode", choices=MODES, default="gt")
    log_parser.add_argument("--iteration", type=int, required=True)
    log_parser.add_argument("--layer", type=int, required=True)
    log_parser.add_argument("--mutation-type", required=True)
    log_parser.add_argument("--description", required=True)
    log_parser.add_argument("--pass-rate", type=float)
    log_parser.add_argument("--win-rate", type=float, help="Pairwise mode: fraction of tasks won vs predecessor")
    log_parser.add_argument("--metric-name")
    log_parser.add_argument("--metric-value", type=float)
    log_parser.add_argument("--metric-direction", choices=["minimize", "maximize"])
    log_parser.add_argument("--delta", type=float, required=True)
    log_parser.add_argument("--decision", choices=DECISIONS, required=True)
    log_parser.add_argument("--oracle-runs", type=int, default=0,
                            help="Artifact executions this iteration consumed (feeds the budget ledger)")
    log_parser.add_argument("--tokens", type=int, default=0)
    log_parser.add_argument("--duration", type=float, default=0.0)
    log_parser.add_argument("--cost-usd", type=float, default=0.0)
    log_parser.add_argument("--mutation-family", default=None)
    log_parser.add_argument("--predicted-effect", default=None,
                            help="The falsifiable prediction made in Phase 2")
    log_parser.add_argument("--prediction-correct", type=lambda v: v.lower() in ("1", "true", "yes"),
                            default=None, help="Whether the prediction held (scored independently of the gate)")
    log_parser.add_argument("--gate-details", default=None)
    log_parser.add_argument("--target-cases", default=None)
    log_parser.add_argument("--regressions", default=None)

    predict_parser = subparsers.add_parser(
        "predict", help="Commit a falsifiable prediction at Phase 2, before the mutation runs")
    predict_parser.add_argument("--iteration", type=int, required=True)
    predict_parser.add_argument("--predicted-effect", required=True,
                                help="What L2 should show, specific enough to be proven wrong")
    predict_parser.add_argument("--mutation-family", default=None)
    predict_parser.add_argument("--target-cases", default=None)

    budget_parser = subparsers.add_parser("budget", help="Show cumulative spend and control-arm sizing")
    budget_parser.add_argument("--total-oracle-runs", type=int, default=None,
                               help="The ceiling from the contract, to report remaining budget")
    budget_parser.add_argument("--set-size", type=int, default=None,
                               help="Case count of the set the control arm will run on, to compute K")

    subparsers.add_parser("summary", help="Show evolution summary")
    subparsers.add_parser("best", help="Show best kept iteration")

    args = parser.parse_args()

    if args.command == "init":
        init_workspace(args.workspace, args.mode)
    elif args.command == "log":
        log_result(args.workspace, args)
    elif args.command == "predict":
        record_prediction(args.workspace, args)
    elif args.command == "budget":
        show_budget(args.workspace, args.total_oracle_runs, args.set_size)
    elif args.command == "summary":
        show_summary(args.workspace)
    elif args.command == "best":
        show_best(args.workspace)


if __name__ == "__main__":
    main()
