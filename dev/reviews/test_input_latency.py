import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("report", Path(__file__).with_name("summarize-input-latency.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class LatencyReportTests(unittest.TestCase):
    @staticmethod
    def sample(label):
        kind = "create" if label == "create/cell" else label.split("/")[1]
        return {"label": label, "phase": "measured", "kind": kind,
                "input_to_result_ms": 30, "presentation_ms": 50, "dom_ms": 40,
                "input_ms": 20, "input_clock": "event.timeStamp",
                "inputs": [{"trusted": True, "at_ms": 20, "handled_ms": 25}],
                "run_id": None if kind == "create" else 1,
                "operation": {"status": "done", "run_id": 1},
                "requests": [{"route": "/api/run", "status": 202}],
                "edits": [{"revision": 2}], "pending_edit_at_run": True}

    def test_tail_latency_keeps_slow_samples(self):
        values = [10] * 28 + [400, 1000]
        self.assertEqual(report.distribution(values),
                         {"n": 30, "median_ms": 10, "p95_ms": 400, "max_ms": 1000})
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            report.distribution([10, float("nan")])

    def test_missing_scenarios_do_not_pass(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, "missing.*scenarios"):
                report.summarize(Path(root))

    def test_complete_baseline_cannot_hide_missing_profiles(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            for case in ("single", "chain", "long", "create"):
                target = path / "baseline" / case
                target.mkdir(parents=True)
                rows = [self.sample(label) for label in sorted(report.LABELS)
                        if label.startswith(case + "/")]
                target.joinpath("result.json").write_text(json.dumps({
                    "mode": "baseline", "fixture": case, "samples": rows * 30,
                    "failure": None, "cleanup": {"forced": False, "exit_status": 0},
                    "channels": {}, "startup": {}}))
            with self.assertRaisesRegex(ValueError, "missing baseline or profiling fixtures"):
                report.summarize(path)

    def test_failed_run_reports_partial_samples_without_acceptance(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            target = path / "baseline" / "single"
            target.mkdir(parents=True)
            target.joinpath("result.json").write_text(json.dumps({
                "mode": "baseline", "fixture": "single", "samples": [self.sample("single/run")],
                "failure": "HTTP 504", "cleanup": {"forced": True, "exit_status": -9},
                "channels": {}}))
            target.joinpath("failed-sample.json").write_text(json.dumps({
                "label": "single/edit-run", "phase": "measured", "failure": "HTTP 504"}))
            path.joinpath("stage-status.json").write_text('{"baseline":1,"profile":0,"cpu_summary":0}')
            with patch("sys.argv", ["report", str(path)]), patch("builtins.print"):
                with self.assertRaises(SystemExit) as raised:
                    report.main()
            self.assertEqual(raised.exception.code, 1)
            result = json.loads(path.joinpath("summary.json").read_text())
            self.assertFalse(result["correctness_passed"])
            self.assertFalse(result["budget_met"])
            self.assertEqual(result["baseline_partial"]["single/run"],
                             {"n": 1, "median_ms": 30, "p95_ms": 30, "max_ms": 30})
            self.assertIn("single/edit-run", result["missing_scenarios"])
            self.assertEqual(result["issues"][1]["error"], "HTTP 504")
            self.assertEqual(result["issues"][1]["phase"], "measured")
            self.assertIn("run FAILED", path.joinpath("summary.md").read_text())

    def test_incomplete_or_missing_trace_is_fatal(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            path.joinpath("trace").mkdir()
            path.joinpath("trace/trace-1.jsonl").write_text(json.dumps(
                {"pid": 1, "span": 1, "stage": "analysis", "event": "begin"}) + "\n")
            with self.assertRaisesRegex(ValueError, "incomplete trace"):
                report.read_spans(path)
        with self.assertRaisesRegex(ValueError, "missing correlated HTTP"):
            report.attribute({"requests": [{"server_span": "1:4"}], "kind": "run", "run_id": 1}, {})

    def test_wrong_run_and_missing_trusted_input_fail(self):
        row = {"input_to_result_ms": 30, "presentation_ms": 50, "dom_ms": 40,
               "input_ms": 20, "input_clock": "event.timeStamp",
               "inputs": [{"trusted": True, "at_ms": 20, "handled_ms": 25}], "kind": "run", "run_id": 2,
               "operation": {"status": "done", "run_id": 1}, "requests": []}
        with self.assertRaisesRegex(ValueError, "wrong operation"):
            report.validate_sample(row)
        row["inputs"] = [{"trusted": False}]
        with self.assertRaisesRegex(ValueError, "trusted input"):
            report.validate_sample(row)

    def test_queued_input_cannot_be_omitted(self):
        row = {"input_to_result_ms": 25, "presentation_ms": 50, "dom_ms": 40,
               "input_ms": 25, "input_clock": "event.timeStamp",
               "inputs": [{"trusted": True, "at_ms": 20, "handled_ms": 25}], "kind": "create"}
        with self.assertRaisesRegex(ValueError, "queued input delay was omitted"):
            report.validate_sample(row)

    def test_empty_r_metadata_preserves_http_attribution(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            path.joinpath("trace").mkdir()
            events = []
            for identity, stage, start, duration in ((1, "http", 10, 20),
                                                     (2, "state.encode", 15, 5)):
                span = {"pid": 7, "span": identity, "stage": stage,
                        "start_ms": start, "fields": [],
                        "clock": "microbenchmark::get_nanotime"}
                events.extend([{**span, "event": "begin"},
                               {**span, "event": "end", "duration_ms": duration}])
            path.joinpath("trace/trace-7.jsonl").write_text(
                "".join(json.dumps(event) + "\n" for event in events))
            spans = report.read_spans(path)
            result = report.attribute({"requests": [{"server_span": "7:1"}],
                                       "kind": "create", "run_id": None}, spans)
            self.assertEqual(result["stages_inclusive_ms"], {"http": 20, "state.encode": 5})
            for event in events:
                event["clock"] = "proc.time"
            path.joinpath("trace/trace-7.jsonl").write_text(
                "".join(json.dumps(event) + "\n" for event in events))
            with self.assertRaisesRegex(ValueError, "monotonic clock"):
                report.read_spans(path)


if __name__ == "__main__":
    unittest.main()
