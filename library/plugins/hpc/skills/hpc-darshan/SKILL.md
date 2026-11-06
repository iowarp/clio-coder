---
name: hpc-darshan
description: "Characterizes an application's I/O from a Darshan log: runs darshan-parser through a bundled summarizer, reads volumes, access sizes, sequentiality and collective use, and names the bottleneck the counters support. Not for instrumenting a build or for tuning without a log."
---

# Darshan I/O analysis

A Darshan log records what one run did to the file system: bytes, operation
counts, request-size histograms and time per module (POSIX, MPI-IO, STDIO). Read
it before tuning I/O, and read it again after, so that every claim about I/O
names the counter behind it. The analysis is local and read-only: it needs
`darshan-util` on `PATH` and no network.

## Phase 0 - Find the log and the tool

1. `bash`: `command -v darshan-parser && darshan-parser --version`. If it is
   missing, look for a module (`module -t --redirect spider darshan`, see
   hpc-modules) or a Spack install (`spack find darshan-util`). Without it, stop
   and say that darshan-util is needed. Never guess counters.
2. The log is a `*.darshan` file. Runtime builds write it to the site's log
   directory, organized by date, and `DARSHAN_LOGFILE` names an exact path for
   one run. Ask for the path if it is not given.
3. Capture with Darshan only when asked: link the runtime library, or preload
   it with `LD_PRELOAD=<darshan lib dir>/libdarshan.so` (`darshan-config --libdir`
   prints that directory). Non-MPI programs also need `DARSHAN_ENABLE_NONMPI=1`.

## Phase 1 - Summarize

Run the bundled summarizer as an observable step with `run_script`:

```text
run_script(interpreter="python3",
           script="${pluginRoot}/assets/scripts/darshan_summary.py",
           args=["<log>.darshan"], inputs=["<log>.darshan"])
```

`run_script` accepts only a script inside the workspace. When the pack is
installed for the user rather than the project, run the same command through
`bash` with `python3 <script> <log>`. Add `--json` for machine-readable output.
The summarizer calls `darshan-parser --total --file --perf <log>` and never
writes to the log. It exits 0 with a summary, 1 when darshan-parser refuses the
log or the log is incomplete, and 2 when darshan-parser is missing.

An incomplete log (a module ran out of record memory) makes darshan-parser fail.
Rerun with `--show-incomplete` only to look; the report must then say that the
module's data is incomplete.

For one counter the summary omits, use darshan-parser directly:
`darshan-parser --base <log> | grep -E '<COUNTER>'` lists it per file and rank
(rank -1 is a shared file aggregated across ranks). The summarizer was checked
against the darshan-util 3.5.0 output format. If a field comes back missing on
another version, read the raw `--total` output instead of assuming a zero.

## Phase 2 - Read the counters

Read each pattern from its counters, and name them:

| Pattern | Counters |
| --- | --- |
| Many small requests | `POSIX_SIZE_WRITE_0_100`, `POSIX_SIZE_WRITE_100_1K` (and `_READ_`) against `POSIX_WRITES` |
| Random rather than sequential | `POSIX_SEQ_WRITES` / `POSIX_WRITES`; `POSIX_SEEKS` |
| Metadata bound | `POSIX_F_META_TIME` against read and write time; `POSIX_OPENS`, `POSIX_STATS` |
| Collective path not taken | `MPIIO_COLL_WRITES` = 0 with `MPIIO_INDEP_WRITES` > 0 |
| Shared-file contention | `shared` file count and bytes, `time_by_slowest` for shared files |
| Achieved rate | `agg_perf_by_slowest` (MiB/s) with `agg_time_by_slowest` |

The summarizer prints the ratios it derives (small-request share,
sequential share, metadata time share, collective share), each computed from
the counters named above. They describe the run. They are not verdicts.

## Phase 3 - Compare runs

To judge a change, summarize both logs with `--json` and compare the same
counters. A rate change is meaningful only between runs of the same input, the
same rank count and the same file system. Say which of those differ.

## Final answer

Give the log path, the job (`exe`, `nprocs`, `jobid`, run time), the two or
three counters that carry the finding, and the change they suggest. For
parallel HDF5 or MPI-IO fixes, hand over to hpc-parallel-io.
