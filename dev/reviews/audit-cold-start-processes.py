#!/usr/bin/env python3
"""Observe a cold release gate without stopping or changing any process."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time


def processes():
    rows = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = entry.joinpath("stat").read_text()
            fields = stat[stat.rfind(")") + 2 :].split()
            args = entry.joinpath("cmdline").read_bytes().split(b"\0")
            args = [value.decode("utf-8", errors="replace") for value in args if value]
        except FileNotFoundError:
            continue  # This process finished during observation.
        rows.append({"pid": int(entry.name), "ppid": int(fields[1]),
                     "state": fields[0], "started_ticks": int(fields[19]), "args": args})
    return rows


def ancestry(rows):
    by_pid = {row["pid"]: row for row in rows}
    ids = set()
    cursor = os.getpid()
    while cursor in by_pid and cursor not in ids:
        ids.add(cursor)
        cursor = by_pid[cursor]["ppid"]
    return [row for row in rows if row["pid"] in ids]


def listeners():
    result = subprocess.run(["ss", "-H", "-ltnp"], check=True,
                            capture_output=True, text=True)
    if result.stderr.strip():
        raise RuntimeError("ss reported diagnostics: " + result.stderr)
    rows = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) < 5:
            raise RuntimeError("unrecognized ss output: " + line)
        address = fields[3]
        port = int(address.rsplit(":", 1)[1])
        rows.append({"address": address, "port": port, "raw": line})
    return rows


def observe(audit_root, evidence):
    rows = processes()
    ancestors = ancestry(rows)
    excluded = {row["pid"] for row in ancestors}
    live = []
    for row in rows:
        if row["pid"] in excluded or row["state"] == "Z":
            continue
        args = row["args"]
        command = " ".join(args)
        executable = Path(args[0]).name if args else ""
        workload = executable in {"R", "Rscript", "chrome", "google-chrome",
                                  "chromium", "chromium-browser", "chromedriver"}
        workload = workload or "chrome_crashpad_handler" in executable
        workload = workload or "processx/bin/supervisor" in command
        workload = workload or "languageserver::run" in command
        workload = workload or str(audit_root) in command or str(evidence) in command
        if workload:
            live.append(row)
    return {
        "processes": rows,
        "excluded_ancestry": ancestors,
        "subreaper_ancestor": any(row["args"] and
            Path(row["args"][0]).name == "tini" and "-s" in row["args"]
            for row in ancestors),
        "live_workloads": live,
        "zombies": [row for row in rows if row["state"] == "Z"],
        "listeners": listeners(),
    }


def observed_ports(evidence):
    ports = set()
    url = re.compile(r"(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\b")
    allocated = re.compile(r"(?:layout_boundary_port|accessibility_port)=([0-9]{1,5})\b")
    for path in evidence.rglob("*"):
        if not path.is_file() or path.suffix not in {".log", ".json", ".txt", ".Rout", ".fail"}:
            continue
        if path.name.startswith(("00-process-", "98-process-", "99-result")):
            continue
        with path.open(encoding="utf-8", errors="replace") as stream:
            carry = ""
            while chunk := stream.read(262144):
                text = carry + chunk
                ports.update(int(match) for pattern in (url, allocated)
                             for match in pattern.findall(text))
                carry = text[-256:]
    return sorted(port for port in ports if 1 <= port <= 65535)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("baseline", "final"), required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--audit-root", type=Path, required=True)
    args = parser.parse_args()
    evidence = args.evidence_dir.resolve(strict=True)
    audit_root = args.audit_root.resolve(strict=True)
    baseline_file = evidence / "00-process-baseline.json"
    baseline = None
    if args.phase == "final":
        baseline = json.loads(baseline_file.read_text())
    ports = observed_ports(evidence) if baseline else []
    baseline_addresses = {row["address"] for row in baseline["listeners"]} if baseline else set()
    attempts = []
    deadline = time.monotonic() + (10 if baseline else 0)
    while True:
        result = observe(audit_root, evidence)
        failures = []
        if not result["subreaper_ancestor"]:
            failures.append("driver must remain below a long-lived tini -s")
        if result["live_workloads"]:
            failures.append("live R/Alder/LSP/Chrome/processx or review-owned processes remain")
        if result["zombies"]:
            failures.append("container zombie count is not zero")
        if baseline:
            if not baseline["pass"]:
                failures.append("cold baseline did not pass")
            original = {(row["pid"], row["started_ticks"]) for row in baseline["processes"]}
            excluded = {row["pid"] for row in result["excluded_ancestry"]}
            result["new_live_processes"] = [row for row in result["processes"]
                if row["state"] != "Z" and row["pid"] not in excluded and
                (row["pid"], row["started_ticks"]) not in original]
            if result["new_live_processes"]:
                failures.append("processes created after the cold baseline remain")
            result["new_listeners"] = [row for row in result["listeners"]
                                       if row["address"] not in baseline_addresses]
            result["observed_ports"] = ports
            result["open_observed_ports"] = [row for row in result["listeners"]
                                             if row["port"] in ports]
            if result["new_listeners"]:
                failures.append("TCP listeners opened after the baseline remain")
            if result["open_observed_ports"]:
                failures.append("a port observed in validation evidence remains open")
        attempts.append({"live_workloads": len(result["live_workloads"]),
                         "zombies": len(result["zombies"]), "failures": failures})
        if not failures or time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    result.update({"phase": args.phase, "pass": not failures,
                   "failures": failures, "attempts": attempts})
    destination = baseline_file if not baseline else evidence / "98-process-final.json"
    destination.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
