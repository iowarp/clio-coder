#!/usr/bin/env python3
"""Summarize one Darshan log from darshan-parser text output.

Runs `darshan-parser --total --file --perf <log>` (read-only), parses the job
header and each module's aggregate counters, file counts and performance
estimate, and prints a compact report. The text format it reads is the one
darshan-util 3.5.0 prints; the parser has been checked against that documented
format, not against logs from every Darshan release.

Exit codes: 0 summary printed, 1 the log is incomplete or darshan-parser
refused it, 2 usage error or darshan-parser missing.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys

SECTION = re.compile(r"^# (\S+) module data$")
TOTAL = re.compile(r"^total_([A-Z0-9_]+): (-?[0-9.]+)$")
FILE_COUNT = re.compile(r"^# (total|read_only|write_only|read_write|unique|shared): (-?\d+) (-?\d+) (-?\d+)$")
PERF = re.compile(r"^# (agg_perf_by_slowest|agg_time_by_slowest|total_bytes): (-?[0-9.]+)")
HEADER = {
    "darshan log version": "log_version",
    "exe": "exe",
    "jobid": "jobid",
    "nprocs": "nprocs",
    "run time": "run_time_s",
}
SIZE_BINS = ("0_100", "100_1K", "1K_10K", "10K_100K", "100K_1M", "1M_4M", "4M_10M", "10M_100M", "100M_1G", "1G_PLUS")


def number(text: str) -> float | int:
    value = float(text)
    return int(value) if value.is_integer() and "." not in text else value


def parse(text: str) -> dict:
    job: dict = {}
    modules: dict[str, dict] = {}
    current: dict | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        section = SECTION.match(line)
        if section:
            current = modules.setdefault(section.group(1), {"totals": {}, "files": {}, "perf": {}})
            continue
        if current is None:
            if line.startswith("# ") and ":" in line:
                key, _, value = line[2:].partition(":")
                if key in HEADER:
                    value = value.strip()
                    job[HEADER[key]] = value if key in ("exe", "darshan log version") else number(value)
            continue
        if line.startswith("# *WARNING*"):
            current["incomplete"] = True
        elif match := TOTAL.match(line):
            current["totals"][match.group(1)] = number(match.group(2))
        elif match := FILE_COUNT.match(line):
            count, nbytes, offset = (int(match.group(i)) for i in (2, 3, 4))
            current["files"][match.group(1)] = {"count": count, "bytes": nbytes, "max_offset": offset}
        elif match := PERF.match(line):
            current["perf"][match.group(1)] = number(match.group(2))
    return {"job": job, "modules": modules}


def ratio(part: float, whole: float) -> float | None:
    return None if whole <= 0 or part < 0 else round(part / whole, 4)


def derive(modules: dict) -> dict:
    """Ratios computed from named counters; each states its inputs, none is a verdict."""
    out: dict = {}
    posix = modules.get("POSIX", {}).get("totals", {})
    if posix:
        reads, writes = posix.get("POSIX_READS", 0), posix.get("POSIX_WRITES", 0)
        small_reads = sum(posix.get(f"POSIX_SIZE_READ_{b}", 0) for b in SIZE_BINS[:2])
        small_writes = sum(posix.get(f"POSIX_SIZE_WRITE_{b}", 0) for b in SIZE_BINS[:2])
        io_time = sum(posix.get(k, 0) for k in ("POSIX_F_READ_TIME", "POSIX_F_WRITE_TIME", "POSIX_F_META_TIME"))
        out["POSIX"] = {
            "reads_under_1KiB_share": ratio(small_reads, reads),
            "writes_under_1KiB_share": ratio(small_writes, writes),
            "sequential_read_share": ratio(posix.get("POSIX_SEQ_READS", 0), reads),
            "sequential_write_share": ratio(posix.get("POSIX_SEQ_WRITES", 0), writes),
            "metadata_time_share": ratio(posix.get("POSIX_F_META_TIME", 0), io_time),
        }
    mpiio = modules.get("MPI-IO", {}).get("totals", {})
    if mpiio:
        coll = mpiio.get("MPIIO_COLL_READS", 0) + mpiio.get("MPIIO_COLL_WRITES", 0)
        indep = mpiio.get("MPIIO_INDEP_READS", 0) + mpiio.get("MPIIO_INDEP_WRITES", 0)
        out["MPI-IO"] = {"collective_op_share": ratio(coll, coll + indep)}
    return out


KEY_TOTALS = (
    "BYTES_READ",
    "BYTES_WRITTEN",
    "READS",
    "WRITES",
    "OPENS",
    "F_READ_TIME",
    "F_WRITE_TIME",
    "F_META_TIME",
    "INDEP_READS",
    "INDEP_WRITES",
    "COLL_READS",
    "COLL_WRITES",
)


def render(summary: dict, log: str) -> str:
    job = summary["job"]
    lines = [
        f"log: {log}",
        f"exe: {job.get('exe', '?')}  jobid: {job.get('jobid', '?')}  nprocs: {job.get('nprocs', '?')}  "
        f"run time: {job.get('run_time_s', '?')} s  log version: {job.get('log_version', '?')}",
    ]
    for name, module in summary["modules"].items():
        prefix = "MPIIO" if name == "MPI-IO" else name
        lines.append(f"[{name}]" + ("  INCOMPLETE DATA" if module.get("incomplete") else ""))
        picked = {k: module["totals"][f"{prefix}_{k}"] for k in KEY_TOTALS if f"{prefix}_{k}" in module["totals"]}
        if picked:
            lines.append("  totals: " + ", ".join(f"{k}={v}" for k, v in picked.items()))
        for kind in ("total", "read_only", "write_only", "read_write", "shared", "unique"):
            entry = module["files"].get(kind)
            if entry and (entry["count"] > 0 or kind == "total"):
                lines.append(f"  files {kind}: {entry['count']} files, {entry['bytes']} bytes")
        perf = module["perf"]
        if "agg_perf_by_slowest" in perf:
            lines.append(
                f"  agg_perf_by_slowest: {perf['agg_perf_by_slowest']} MiB/s "
                f"(agg_time_by_slowest {perf.get('agg_time_by_slowest', '?')} s)"
            )
        for key, value in summary["derived"].get(name, {}).items():
            lines.append(f"  {key}: {'n/a' if value is None else value}")
    if not summary["modules"]:
        lines.append("no POSIX, MPI-IO or STDIO module data in this log")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("log", help="path to a .darshan log")
    parser.add_argument("--parser", default="darshan-parser", help="darshan-parser executable (default: on PATH)")
    parser.add_argument("--show-incomplete", action="store_true", help="pass --show-incomplete to darshan-parser")
    parser.add_argument("--json", action="store_true", help="print JSON instead of text")
    args = parser.parse_args(argv)
    exe = shutil.which(args.parser)
    if exe is None:
        print(f"darshan_summary: {args.parser} not found; install darshan-util", file=sys.stderr)
        return 2
    command = [exe, "--total", "--file", "--perf"]
    if args.show_incomplete:
        command.append("--show-incomplete")
    result = subprocess.run([*command, args.log], capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        print(f"darshan_summary: darshan-parser exited {result.returncode}", file=sys.stderr)
        return 1
    summary = parse(result.stdout)
    summary["derived"] = derive(summary["modules"])
    summary["command"] = command + [args.log]
    print(json.dumps(summary, indent=1) if args.json else render(summary, args.log))
    return 1 if any(m.get("incomplete") for m in summary["modules"].values()) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
