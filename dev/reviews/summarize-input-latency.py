#!/usr/bin/env python3
"""Summarize retained browser samples and correlate separate process-local spans."""
import argparse
import json
import math
from pathlib import Path
import statistics


LABELS = {f"{case}/{flow}" for case in ("single", "chain", "long")
          for flow in ("run", "edit-run")} | {"create/cell"}


def distribution(values):
    if not values or any(not math.isfinite(x) or x < 0 for x in values):
        raise ValueError("missing, negative or nonfinite timing")
    ordered = sorted(values)
    return {"n": len(values), "median_ms": statistics.median(values),
            "p95_ms": ordered[math.ceil(.95 * len(ordered)) - 1],
            "max_ms": max(values)}


def validate_sample(sample):
    duration = sample["input_to_result_ms"]
    if not math.isfinite(duration) or duration < 0:
        raise ValueError("invalid input-to-result duration")
    if not sample["inputs"] or not all(x["trusted"] for x in sample["inputs"]):
        raise ValueError("sample lacks trusted input")
    if sample.get("input_clock") != "event.timeStamp":
        raise ValueError("sample must include queued input time")
    if abs(sample["inputs"][0]["at_ms"] - sample["input_ms"]) > .001:
        raise ValueError("queued input delay was omitted")
    for event in sample["inputs"]:
        if not all(math.isfinite(event[k]) for k in ("at_ms", "handled_ms")) or event["at_ms"] > event["handled_ms"] + 1:
            raise ValueError("invalid input clock")
    if sample["presentation_ms"] < sample["dom_ms"] or sample["dom_ms"] < sample["input_ms"]:
        raise ValueError("invalid browser event order")
    if abs(sample["presentation_ms"] - sample["input_ms"] - duration) > .001:
        raise ValueError("duration does not cover the whole input-to-result interval")
    if sample["kind"] != "create":
        if not sample["run_id"] or sample["operation"]["status"] != "done":
            raise ValueError("run did not settle")
        if sample["operation"]["run_id"] != sample["run_id"]:
            raise ValueError("wrong operation identity")
        runs = [x for x in sample["requests"] if x["route"] == "/api/run"]
        if len(runs) != 1 or runs[0]["status"] != 202:
            raise ValueError("expected exactly one accepted run")
    if sample["kind"] == "edit-run" and (not sample["edits"] or not sample["pending_edit_at_run"]):
        raise ValueError("immediate edit was not pending at Run and then acknowledged")


def read_spans(root):
    pending, spans = {}, {}
    for path in root.glob("trace/trace-*.jsonl"):
        for line in path.read_text().splitlines():
            event = json.loads(line)
            key = f'{event["pid"]}:{event["span"]}'
            if event["event"] == "begin":
                if key in pending or key in spans:
                    raise ValueError("duplicate trace span")
                pending[key] = event
            elif event["event"] == "end":
                start = pending.pop(key, None)
                if start is None or start["stage"] != event["stage"]:
                    raise ValueError("trace end without matching start")
                if not math.isfinite(event["duration_ms"]) or event["duration_ms"] < 0:
                    raise ValueError("invalid process-local span duration")
                if event.get("clock") != "microbenchmark::get_nanotime":
                    raise ValueError("trace requires the supported monotonic clock")
                # jsonlite encodes an empty R list as []; populated metadata
                # is an object. Normalize only that legitimate empty case.
                if event["fields"] == []:
                    event["fields"] = {}
                if not isinstance(event["fields"], dict):
                    raise ValueError("invalid trace metadata")
                spans[key] = event
            else:
                raise ValueError("unknown trace event")
    if pending:
        raise ValueError("incomplete trace spans: " + ", ".join(pending))
    return spans


def attribute(sample, spans):
    http = []
    for request in sample["requests"]:
        key = request.get("server_span")
        if key is None or key not in spans:
            raise ValueError("missing correlated HTTP span")
        http.append(spans[key])
    run_id = sample.get("run_id")
    dispatch = [s for s in spans.values() if s["stage"] == "worker.dispatch"
                and s["fields"].get("run_id") == run_id and run_id is not None]
    selected = []
    for s in spans.values():
        # HTTP/analysis durations use the same server monotonic clock.
        inside_http = any(s["pid"] == h["pid"] and s["start_ms"] >= h["start_ms"]
                          and s["start_ms"] + s["duration_ms"] <= h["start_ms"] + h["duration_ms"] + .001
                          for h in http)
        in_run = run_id is not None and s["fields"].get("run_id") == run_id
        if inside_http or in_run:
            selected.append(s)
    stages = {}
    for s in selected:
        stages.setdefault(s["stage"], []).append(s["duration_ms"])
    if run_id is not None:
        for required in ("worker.dispatch", "worker.receive", "kernel.execute", "kernel.evaluate", "result.commit"):
            if required not in stages:
                raise ValueError("missing required stage: " + required)
    if sample["kind"] == "edit-run" and "analysis" not in stages:
        raise ValueError("missing edited-source analysis trace")
    waits = []
    for sent in dispatch:
        responses = [s for s in selected if s["stage"] == "worker.receive"
                     and s["pid"] == sent["pid"]
                     and s["fields"].get("req") == sent["fields"]["req"]
                     and not s["fields"].get("ack") and not s["fields"].get("notify")]
        if len(responses) != 1:
            raise ValueError("missing or ambiguous worker completion")
        waits.append(responses[0]["start_ms"] - sent["start_ms"])
    return {"stages_inclusive_ms": {name: sum(values) for name, values in stages.items()},
            "worker_dispatch_to_receive_ms": waits,
            "note": "Nested/inclusive spans are not additive; browser and process clocks are never subtracted."}


def summarize(root):
    status = root / "stage-status.json"
    if status.exists() and any(json.loads(status.read_text()).values()):
        raise ValueError("driver stages failed; see stage-status.json and fixture failures")
    groups, profiles, startups, fixtures, profiled = {}, [], [], set(), set()
    for path in sorted(root.glob("*/*/result.json")):
        result = json.loads(path.read_text())
        fixtures.add((result["mode"], result["fixture"]))
        if result["failure"] or result["cleanup"]["forced"] or result["cleanup"]["exit_status"] != 0:
            raise ValueError(f"failed fixture: {path}")
        if any(result["channels"].values()):
            raise ValueError(f"browser failure: {path}")
        startups.append({"mode": result["mode"], "fixture": result["fixture"],
                         **result["startup"]})
        spans = read_spans(path.parent) if result["mode"] == "profile" else {}
        if result["mode"] == "profile":
            for pid in {s["pid"] for s in spans.values()}:
                if not path.parent.joinpath(f"trace/cpu-{pid}.Rprof.json").is_file():
                    raise ValueError("missing CPU profile summary")
        for sample in result["samples"]:
            validate_sample(sample)
            if result["mode"] == "profile":
                profiles.append({"label": sample["label"], "phase": sample["phase"],
                                 "run_id": sample["run_id"], **attribute(sample, spans)})
                if sample["phase"] == "measured":
                    profiled.add(sample["label"])
            elif sample["phase"] == "measured":
                groups.setdefault(sample["label"], []).append(sample["input_to_result_ms"])
    if set(groups) != LABELS:
        raise ValueError("missing or unexpected benchmark scenarios")
    if fixtures != {(mode, case) for mode in ("baseline", "profile")
                    for case in ("single", "chain", "long", "create")} or profiled != LABELS:
        raise ValueError("missing baseline or profiling fixtures")
    summaries = {name: distribution(values) for name, values in groups.items()}
    for value in summaries.values():
        value["budget_met"] = value["n"] >= 30 and value["median_ms"] <= 50 and value["p95_ms"] <= 100
    return {"correctness_passed": True, "budget_met": all(x["budget_met"] for x in summaries.values()),
            "targets": {"minimum_samples": 30, "median_ms": 50, "p95_ms": 100},
            "input_clock": "event.timeStamp (includes main-thread input queuing)",
            "endpoint": "visible current result after two animation frames; paint opportunity proxy",
            "baseline": summaries, "startup": startups, "profiles": profiles}


def diagnose(root, reason):
    """Retain useful partial evidence while keeping the whole run failed."""
    groups, issues, profiles = {}, [], []
    for path in sorted(root.glob("*/*/result.json")):
        try:
            result = json.loads(path.read_text())
            if result["failure"] or result["cleanup"].get("forced") or any(result["channels"].values()):
                issues.append({"fixture": str(path.relative_to(root)),
                               "failure": result["failure"], "cleanup": result["cleanup"],
                               "channels": result["channels"]})
            failed = path.parent / "failed-sample.json"
            if failed.is_file():
                active = json.loads(failed.read_text())
                issues.append({"failed_action": active.get("label"), "phase": active.get("phase"),
                               "error": active.get("failure"), "evidence": str(failed.relative_to(root))})
            spans = read_spans(path.parent) if result["mode"] == "profile" else {}
            for sample in result["samples"]:
                validate_sample(sample)
                if sample["phase"] != "measured":
                    continue
                if result["mode"] == "baseline":
                    groups.setdefault(sample["label"], []).append(sample["input_to_result_ms"])
                else:
                    profiles.append({"label": sample["label"], "run_id": sample["run_id"],
                                     **attribute(sample, spans)})
        except (ValueError, KeyError, TypeError) as error:
            issues.append({"fixture": str(path.relative_to(root)), "evidence_error": str(error)})
    return {"correctness_passed": False, "budget_met": False, "failure": reason,
            "note": "Completed samples only. Failed/unfinished actions and missing scenarios invalidate latency acceptance.",
            "missing_scenarios": sorted(LABELS - set(groups)), "issues": issues,
            "baseline_partial": {name: distribution(values) for name, values in groups.items()},
            "profiles_partial": profiles}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--enforce-budget", action="store_true")
    args = parser.parse_args()
    try:
        report = summarize(args.evidence)
    except (ValueError, KeyError, TypeError) as error:
        report = diagnose(args.evidence, str(error))
        args.evidence.joinpath("summary.json").write_text(json.dumps(report, indent=2) + "\n")
        lines = ["# Input-to-result run FAILED", "", report["failure"], "", report["note"], "",
                 "| Scenario | Completed samples | Median ms | p95 of completed samples ms |",
                 "| --- | ---: | ---: | ---: |"]
        for name, row in report["baseline_partial"].items():
            lines.append(f'| {name} | {row["n"]} | {row["median_ms"]:.1f} | {row["p95_ms"]:.1f} |')
        lines += ["", "Failures, missing scenarios and available profile attribution are retained in summary.json."]
        args.evidence.joinpath("summary.md").write_text("\n".join(lines) + "\n")
        print("\n".join(lines))
        raise SystemExit(1) from error
    args.evidence.joinpath("summary.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = ["# Input-to-result baseline", "", "Instrumented profiling runs are excluded from this table.", "",
             "| Scenario | Samples | Median ms | p95 ms | Max ms | Target met |",
             "| --- | ---: | ---: | ---: | ---: | --- |"]
    for name, row in report["baseline"].items():
        lines.append(f'| {name} | {row["n"]} | {row["median_ms"]:.1f} | {row["p95_ms"]:.1f} | {row["max_ms"]:.1f} | {row["budget_met"]} |')
    lines += ["", "Timing endpoint: " + report["endpoint"] + ".",
              "Cold readiness/first executions and per-run inclusive stage attribution are in summary.json and raw fixture samples.",
              "", "Correctness passed; latency target " + ("met." if report["budget_met"] else "NOT met.")]
    args.evidence.joinpath("summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    if args.enforce_budget and not report["budget_met"]:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
